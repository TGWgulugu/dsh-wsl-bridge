/**
 * The persistent WSL shell engine: one `bash -l -s` inside the distribution per
 * calling agent, plus one-shot `bash -lc` runs for the file tools.
 *
 * Why a persistent shell at all: an agent's `cd`, exported variables, functions
 * and aliases must survive between `wsl_bash` calls, so the shell process state
 * itself is the state store. The process is driven over piped stdio with the
 * frame protocol from ./protocol.js: each call writes one frame to stdin and
 * reads its own stdout/exit status back out of the continuous byte stream.
 *
 * Why not `wsl.exe -e bash -lc <cmd>` for everything: that starts a NEW process
 * per call, which is exactly the one-shot path (`runOnce`). The persistent path
 * needs stdin held open for the lifetime of the agent.
 *
 * Recovery policy: a shell that exits, wedges or fails a write is torn down; the
 * CURRENT call reports what it observed and the NEXT call starts a fresh shell
 * with `shellRestarted: true`, so the model learns that earlier `cd`/exports are
 * gone instead of silently running in the wrong directory.
 *
 * Zero dependencies: only node built-ins and local modules are imported. The
 * subprocess seam is injected (`spawn`), never imported, so unit tests drive
 * this module without a host or a WSL installation.
 *
 * @module dsh-wsl-bridge/shell
 */
import { buildFrame, createFrameParser } from './protocol.js'

/** Exit status reported for a call killed by its own deadline. */
export const TIMEOUT_EXIT_CODE = 124

/** Default visible stdout budget for one persistent-shell call, in bytes. */
export const DEFAULT_MAX_STDOUT_BYTES = 128 * 1024

/** Default visible stderr budget for one persistent-shell call, in bytes. */
export const DEFAULT_MAX_STDERR_BYTES = 32 * 1024

/**
 * Default stdout budget for `runOnce`, in bytes. The file tools stream base64
 * through this channel (`wsl_read` of a 2 MiB file is ~2.7 MiB of base64), so
 * this budget is far larger than a human-facing shell budget; cutting it would
 * corrupt the payload instead of merely shortening a display.
 */
export const DEFAULT_RUN_ONCE_STDOUT_BYTES = 32 * 1024 * 1024

/** Default stderr budget for `runOnce`, in bytes. */
export const DEFAULT_RUN_ONCE_STDERR_BYTES = 4 * 1024 * 1024

/** Default ceiling on the bytes buffered while looking for a frame end. */
export const DEFAULT_FRAME_WATCH_BYTES = 4 * 1024 * 1024

/** Default cap for one stream's spill file, in bytes. */
export const DEFAULT_SPILL_BYTES = 64 * 1024 * 1024

/** Default grace period handed to the subprocess seam for range teardown. */
export const DEFAULT_GRACE_MS = 5_000

/** Default poll cadence while waiting for a frame to complete, in ms. */
export const DEFAULT_POLL_INTERVAL_MS = 15

/** Fallback command deadline when neither the request nor the config sets one. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Tunables this module owns; any of them may be overridden through `config`. */
const DEFAULTS = Object.freeze({
  /** WSL distribution name; empty means the system default distribution. */
  distro: '',
  /** Command deadline applied by `run` when the request does not set one. */
  timeoutMs: DEFAULT_TIMEOUT_MS,
  /** Poll cadence while a frame is incomplete. */
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  /** How long teardown may take before it is abandoned. */
  graceMs: DEFAULT_GRACE_MS,
  /** Visible stdout budget for a persistent-shell command. */
  maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
  /** Visible stderr budget for a persistent-shell command. */
  maxStderrBytes: DEFAULT_MAX_STDERR_BYTES,
  /** Stdout budget for a one-shot command (base64 payloads). */
  runOnceStdoutBytes: DEFAULT_RUN_ONCE_STDOUT_BYTES,
  /** Stderr budget for a one-shot command. */
  runOnceStderrBytes: DEFAULT_RUN_ONCE_STDERR_BYTES,
  /** Bytes buffered while looking for a frame end. */
  frameWatchBytes: DEFAULT_FRAME_WATCH_BYTES,
  /** Per-stream spill file cap. */
  spillBytes: DEFAULT_SPILL_BYTES,
  /** Windows working directory of the spawned wsl.exe process. */
  cwd: undefined,
})

/**
 * Failure raised when the engine cannot serve a call at all (as opposed to a
 * command that ran and exited nonzero, which is a normal RunResult).
 *
 * `code` is stable: 'spawn-failed', 'no-stdin', 'shell-write-failed',
 * 'disposed'. The message is written to be safe to show the model.
 */
export class ShellUnavailableError extends Error {
  /**
   * @param {string} code - stable machine-readable reason.
   * @param {string} message - explanation safe to show the model.
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ShellUnavailableError'
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * The argv of the per-agent persistent shell: the distribution's login bash
 * reading its commands from stdin. `-l` picks up the user's login profile (the
 * same environment an interactive WSL session has); `-s` makes it read commands
 * from stdin instead of `-c`.
 *
 * @param {{distro?: string}} [options]
 * @returns {string[]}
 */
export function buildShellArgv(options = {}) {
  const distro = typeof options.distro === 'string' ? options.distro : ''
  return ['wsl.exe', ...(distro === '' ? [] : ['-d', distro]), '-e', 'bash', '-l', '-s']
}

/**
 * The argv of one one-shot command. `--cd` changes the directory inside the
 * distribution before bash starts, so a failing directory is reported by WSL
 * itself instead of by a `cd` prologue.
 *
 * @param {{distro?: string, workdir?: string, command: string}} options
 * @returns {string[]}
 */
export function buildOneShotArgv(options) {
  const distro = typeof options.distro === 'string' ? options.distro : ''
  const workdir = typeof options.workdir === 'string' ? options.workdir : ''
  return [
    'wsl.exe',
    ...(distro === '' ? [] : ['-d', distro]),
    ...(workdir === '' ? [] : ['--cd', workdir]),
    '-e',
    'bash',
    '-lc',
    String(options.command ?? ''),
  ]
}

/**
 * Quote a value for bash (single quotes, embedded quotes escaped).
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/gu, "'\\''") + "'"
}

/**
 * Create the shell pool for one plugin mount.
 *
 * @param {{
 *   spawn: (options: object) => object,
 *   config?: object,
 *   logger?: object|Function,
 * }} options - `spawn` is `ctx.subprocess.spawn` behind a thin closure;
 *   `config` is the resolved bridge config (only the engine's own keys are
 *   read); `logger` accepts either a cordis-style `{info,warn,error,debug}`
 *   object or a `(level, message)` function.
 * @returns {{
 *   run: (agentId: unknown, request: object) => Promise<object>,
 *   runOnce: (request: object) => Promise<object>,
 *   dispose: (agentId: unknown, reason?: string) => Promise<void>,
 *   disposeAll: (reason?: string) => Promise<void>,
 *   has: (agentId: unknown) => boolean,
 *   readonly size: number,
 * }}
 */
export function createShellPool(options) {
  if (options === undefined || options === null || typeof options.spawn !== 'function') {
    throw new TypeError('createShellPool: spawn must be a function')
  }
  const spawn = options.spawn
  const settings = readSettings(options.config)
  const log = makeLogger(options.logger)

  /** Live shells, keyed by calling agent (object or string identity). */
  const shells = new Map()
  /** Per-key promise chain: two calls on one shell never interleave. */
  const locks = new Map()
  /** Keys whose previous shell was torn down and must report a restart. */
  const restarts = new Set()

  /**
   * Chain one task after the previous task for the same key, so two calls on one
   * persistent shell can never interleave frames. The chain continues after a
   * rejected task (the next call must still be served).
   * @param {unknown} key
   * @param {() => Promise<object>} task
   * @returns {Promise<object>}
   */
  function serialize(key, task) {
    const previous = locks.get(key) ?? Promise.resolve()
    const current = previous.then(task, task)
    const tail = current.then(() => undefined, () => undefined)
    locks.set(key, tail)
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return current
  }

  /**
   * Run one command in the agent's persistent shell, starting it on first use.
   *
   * @param {unknown} agentId - the shell lifetime key (the calling agent).
   * @param {{command: string, workdir?: string, env?: object, timeoutMs?: number,
   *          signal?: AbortSignal}} request
   * @returns {Promise<object>} RunResult (see DESIGN.md).
   */
  async function run(agentId, request) {
    const req = request ?? {}
    const timeoutMs = resolveTimeout(req.timeoutMs, settings.timeoutMs)
    if (isAborted(req.signal)) {
      return makeResult({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true, timeoutMs })
    }
    return serialize(agentId, async () => {
      if (isAborted(req.signal)) {
        return makeResult({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true, timeoutMs })
      }
      const ensured = await ensureShell(agentId)
      return executeOnShell(agentId, ensured, req, timeoutMs)
    })
  }

  /**
   * Run one command in a fresh `wsl.exe ... -e bash -lc` process. Never touches
   * the persistent shell, so file operations are isolated from agent state and
   * from each other.
   *
   * @param {{command: string, workdir?: string, env?: object, timeoutMs?: number,
   *          signal?: AbortSignal, input?: string}} request
   * @returns {Promise<object>} RunResult (see DESIGN.md).
   */
  async function runOnce(request) {
    const req = request ?? {}
    const timeoutMs = resolveTimeout(req.timeoutMs, settings.timeoutMs)
    if (isAborted(req.signal)) {
      return makeResult({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true, timeoutMs })
    }
    const handle = spawnOneShot(req)
    let timedOut = false
    let aborted = false
    /** Exit facts, once the handle settles. */
    let outcome = null
    let settleError = null
    const settled = Promise.resolve(handle.done).then(
      (value) => { outcome = value ?? null; return 'exit' },
      (error) => { settleError = error; return 'error' },
    )
    let timer
    const deadline = new Promise((resolve) => {
      if (timeoutMs <= 0) return
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    let abortHandler
    const abort = new Promise((resolve) => {
      if (req.signal === undefined || req.signal === null) return
      if (isAborted(req.signal)) { resolve('abort'); return }
      abortHandler = () => resolve('abort')
      req.signal.addEventListener('abort', abortHandler, { once: true })
    })
    let first
    try {
      first = await Promise.race([settled, deadline, abort])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (abortHandler !== undefined) {
        try {
          req.signal.removeEventListener('abort', abortHandler)
        } catch {
          // A signal that no longer accepts listeners needs no cleanup.
        }
      }
    }
    if (first === 'timeout') timedOut = true
    if (first === 'abort') aborted = true
    if (first === 'exit') {
      // `done` can fire on the process exit while the captured streams are still
      // draining; waitForExit is the seam's whole-range barrier, so read after
      // it (bounded, in case the provider cannot observe the range any more).
      await settleWithin(Promise.resolve(handle?.waitForExit?.()), settings.graceMs)
    } else {
      await terminate(handle)
      // The terminate makes the process exit; give the seam a bounded moment to
      // report the signal it used, but never block on a provider that cannot.
      await settleWithin(settled, Math.min(settings.graceMs, 2_000))
    }
    const stdout = readWholeStream(handle, 'stdout')
    const stderr = readWholeStream(handle, 'stderr')
    const visibleOut = tailBytes(stdout.text, settings.runOnceStdoutBytes)
    const visibleErr = tailBytes(stderr.text, settings.runOnceStderrBytes)
    const spillPath = stdout.spillPath ?? stderr.spillPath
    let errorText = ''
    if (settleError !== null) errorText = (errorText === '' ? '' : '\n') + '[subprocess error: ' + messageOf(settleError) + ']'
    return makeResult({
      stdout: visibleOut.text,
      truncated: visibleOut.truncated || stdout.lossy === true,
      stderr: visibleErr.text + errorText,
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : numberOrNull(outcome?.exitCode),
      signal: typeof outcome?.signal === 'string' ? outcome.signal : null,
      timedOut,
      aborted,
      timeoutMs,
      spillPath,
    })
  }

  /**
   * Stop one agent's shell and forget it. Safe to call for an unknown key and
   * safe to call while a call is queued (the queued call then starts a fresh
   * shell). Never rejects.
   *
   * @param {unknown} agentId
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async function dispose(agentId, reason = 'disposed') {
    restarts.delete(agentId)
    const shell = shells.get(agentId)
    if (shell === undefined) return
    shells.delete(agentId)
    log('debug', 'wsl bridge: disposing shell (' + reason + ')')
    await reapShell(shell)
  }

  /**
   * Stop every shell this pool owns (plugin unload).
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async function disposeAll(reason = 'plugin unloaded') {
    const live = [...shells.values()]
    shells.clear()
    restarts.clear()
    await Promise.allSettled(live.map((shell) => reapShell(shell)))
    log('debug', 'wsl bridge: disposed ' + String(live.length) + ' shell(s) (' + reason + ')')
  }

  /**
   * Whether the agent currently holds a live shell (tests/diagnostics).
   * @param {unknown} agentId
   * @returns {boolean}
   */
  function has(agentId) {
    const shell = shells.get(agentId)
    return shell !== undefined && !shell.exited
  }

  /**
   * Get the agent's live shell, spawning one when absent or dead.
   * @param {unknown} agentId
   * @returns {Promise<{shell: object, restarted: boolean}>}
   */
  async function ensureShell(agentId) {
    const existing = shells.get(agentId)
    if (existing !== undefined && !existing.exited) return { shell: existing, restarted: false }
    let restarted = restarts.has(agentId)
    restarts.delete(agentId)
    if (existing !== undefined) {
      // A shell that exited on its own is still in the map (its death is the
      // interesting signal); reap its managed range before replacing it.
      shells.delete(agentId)
      restarted = true
      await reapShell(existing)
    }
    const handle = spawnShell()
    const shell = {
      key: agentId,
      handle,
      exited: false,
      exitCode: null,
      signal: null,
      exitError: null,
      cursor: { stdout: 0, stderr: 0 },
      spawnedAt: Date.now(),
    }
    watchExit(shell)
    shells.set(agentId, shell)
    log('debug', 'wsl bridge: started persistent shell for an agent')
    return { shell, restarted }
  }

  /**
   * Spawn the persistent shell process.
   * @returns {object} the subprocess handle.
   */
  function spawnShell() {
    let handle
    try {
      handle = spawn({
        argv: buildShellArgv(settings),
        cwd: settings.cwd,
        stdio: {
          stdin: 'pipe',
          // The frame layer needs the whole stdout byte stream, so the seam's
          // capture window sits at the watch ceiling and anything beyond it
          // lands in a spill file rather than being dropped silently.
          stdout: { maxBytes: settings.frameWatchBytes, spill: { maxBytes: settings.spillBytes } },
          stderr: { maxBytes: settings.frameWatchBytes, spill: { maxBytes: settings.spillBytes } },
        },
        graceMs: settings.graceMs,
      })
    } catch (error) {
      throw new ShellUnavailableError(
        'spawn-failed',
        'cannot start wsl.exe: ' + messageOf(error),
        { cause: error },
      )
    }
    if (handle === undefined || handle === null || typeof handle !== 'object') {
      throw new ShellUnavailableError('spawn-failed', 'the subprocess seam returned no handle for wsl.exe')
    }
    return handle
  }

  /**
   * Spawn one one-shot `wsl.exe ... -e bash -lc <command>` process.
   * @param {object} req
   * @returns {object} the subprocess handle.
   */
  function spawnOneShot(req) {
    const argv = buildOneShotArgv({
      distro: settings.distro,
      workdir: typeof req.workdir === 'string' ? req.workdir : undefined,
      command: req.command,
    })
    // The seam's batch stdin shape writes the payload and closes the descriptor,
    // which is exactly what `base64 -d > file` needs to see EOF. The batch shape
    // is only used when the call actually has input.
    const stdin = req.input === undefined ? 'ignore' : { data: String(req.input) }
    let handle
    try {
      handle = spawn({
        argv,
        cwd: settings.cwd,
        stdio: {
          stdin,
          stdout: { maxBytes: settings.runOnceStdoutBytes, spill: { maxBytes: settings.spillBytes } },
          stderr: { maxBytes: settings.runOnceStderrBytes, spill: { maxBytes: settings.spillBytes } },
        },
        graceMs: settings.graceMs,
        ...(req.env === undefined || req.env === null ? {} : { env: req.env }),
      })
    } catch (error) {
      throw new ShellUnavailableError(
        'spawn-failed',
        'cannot start wsl.exe: ' + messageOf(error),
        { cause: error },
      )
    }
    if (handle === undefined || handle === null || typeof handle !== 'object') {
      throw new ShellUnavailableError('spawn-failed', 'the subprocess seam returned no handle for wsl.exe')
    }
    return handle
  }

  /**
   * Track the shell's own exit so a dead shell is never reused.
   * @param {object} shell
   */
  function watchExit(shell) {
    const done = shell.handle?.done
    if (done === undefined || done === null || typeof done.then !== 'function') {
      shell.exited = true
      return
    }
    done.then(
      (outcome) => {
        shell.exitCode = numberOrNull(outcome?.exitCode)
        shell.signal = typeof outcome?.signal === 'string' ? outcome.signal : null
        shell.exited = true
      },
      (error) => {
        shell.exitError = error
        shell.exited = true
      },
    )
  }

  /**
   * Run one command on a specific live shell.
   * @param {unknown} agentId
   * @param {{shell: object, restarted: boolean}} ensured
   * @param {object} req
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  async function executeOnShell(agentId, ensured, req, timeoutMs) {
    const { shell, restarted } = ensured
    if (isAborted(req.signal)) {
      return makeResult({
        stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true, timeoutMs,
        shellRestarted: restarted,
      })
    }
    const stdin = shell.handle.stdin
    if (stdin === undefined || stdin === null || typeof stdin.write !== 'function') {
      await dropShell(agentId, shell, 'the shell has no writable stdin')
      throw new ShellUnavailableError('no-stdin', 'the persistent WSL shell has no writable stdin')
    }
    const command = composeCommand(req)
    const frame = buildFrame(command)
    const parser = createFrameParser({ watchBytes: settings.frameWatchBytes })
    let stdoutCursor = shell.cursor.stdout
    let stderrCursor = shell.cursor.stderr
    /** Set once a collected reader reports its stream was cut or spilled. */
    let spillPath
    const drain = (channel) => {
      const reader = shell.handle.collected?.[channel]
      if (reader === undefined || reader === null || typeof reader.readFrom !== 'function') return ''
      const offset = channel === 'stdout' ? stdoutCursor : stderrCursor
      let read
      try {
        read = reader.readFrom(offset)
      } catch (error) {
        log('warn', 'wsl bridge: cannot read the shell ' + channel + ' stream: ' + messageOf(error))
        return ''
      }
      if (read === undefined || read === null) return ''
      const text = typeof read.text === 'string' ? read.text : ''
      const next = Number.isSafeInteger(read.nextOffset) && read.nextOffset >= offset
        ? read.nextOffset
        : offset + Buffer.byteLength(text, 'utf8')
      if (channel === 'stdout') stdoutCursor = next
      else stderrCursor = next
      if (typeof read.spillPath === 'string' && read.spillPath !== '') spillPath = read.spillPath
      return text
    }
    const resume = () => {
      shell.cursor.stdout = stdoutCursor
      shell.cursor.stderr = stderrCursor
    }

    try {
      stdin.write(frame.payload)
    } catch (error) {
      await dropShell(agentId, shell, 'writing the command frame failed')
      throw new ShellUnavailableError(
        'shell-write-failed',
        'cannot send the command to the persistent WSL shell: ' + messageOf(error),
        { cause: error },
      )
    }

    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity
    for (;;) {
      if (isAborted(req.signal)) {
        resume()
        await dropShell(agentId, shell, 'the call was aborted')
        const partial = parser.partial()
        return makeResult({
          stdout: tailBytes(partial.stdout, settings.maxStdoutBytes).text,
          stderr: tailBytes(partial.stderr, settings.maxStderrBytes).text,
          exitCode: null,
          signal: shell.signal,
          timedOut: false,
          aborted: true,
          timeoutMs,
          shellRestarted: restarted,
        })
      }
      // stderr is drained BEFORE stdout: a complete stdout frame ends the call,
      // and the parser's result snapshots the stderr it has seen, so bytes that
      // arrived in the same poll must already be in the parser when it matches.
      const errChunk = drain('stderr')
      if (errChunk !== '') parser.feed(errChunk, 'stderr')
      const outChunk = drain('stdout')
      let matched
      if (outChunk !== '') matched = parser.feed(outChunk, 'stdout')
      if (matched !== undefined && matched.matched === true) {
        // One last stderr read: bash writes the command's stderr before the end
        // marker, so a late flush can land between the two reads.
        const trailingErr = drain('stderr')
        resume()
        return makeResult({
          stdout: tailBytes(matched.stdout ?? '', settings.maxStdoutBytes).text,
          stderr: tailBytes((matched.stderr ?? '') + trailingErr, settings.maxStderrBytes).text,
          exitCode: matched.exitCode,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs,
          shellRestarted: restarted,
          spillPath,
        })
      }
      if (shell.exited) {
        // The command ended the shell itself (an explicit `exit N`) or the
        // process died. Whatever was recoverable is reported with the shell's
        // own status; the next call starts a fresh shell and says so.
        resume()
        shells.delete(agentId)
        restarts.add(agentId)
        await reapShell(shell)
        const partial = parser.partial()
        return makeResult({
          stdout: tailBytes(partial.stdout, settings.maxStdoutBytes).text,
          stderr: tailBytes(partial.stderr, settings.maxStderrBytes).text,
          exitCode: shell.exitCode,
          signal: shell.signal,
          timedOut: false,
          aborted: false,
          timeoutMs,
          shellRestarted: true,
        })
      }
      if (Date.now() > deadline) {
        resume()
        await dropShell(agentId, shell, 'the command exceeded its time budget')
        const partial = parser.partial()
        return makeResult({
          stdout: tailBytes(partial.stdout, settings.maxStdoutBytes).text,
          stderr: tailBytes(partial.stderr, settings.maxStderrBytes).text,
          exitCode: TIMEOUT_EXIT_CODE,
          signal: shell.signal,
          timedOut: true,
          aborted: false,
          timeoutMs,
          shellRestarted: restarted,
        })
      }
      await sleep(settings.pollIntervalMs)
    }
  }

  /**
   * Remove a shell from the pool and mark that its state is gone.
   * @param {unknown} agentId
   * @param {object} shell
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async function dropShell(agentId, shell, reason) {
    if (shells.get(agentId) === shell) shells.delete(agentId)
    if (!shell.exited) restarts.add(agentId)
    log('debug', 'wsl bridge: dropping shell: ' + reason)
    await reapShell(shell)
  }

  return {
    run,
    runOnce,
    dispose,
    disposeAll,
    has,
    get size() {
      return shells.size
    },
  }
}

/**
 * Compose the command handed to the frame: the explicit workdir `cd`, the
 * per-call `export`s and then the model's command, joined so a failed `cd`
 * stops the command from running in the wrong directory.
 *
 * Environment semantics: a persistent shell cannot have its process environment
 * changed from outside, so `req.env` is exported INTO the shell before the
 * command runs — the same thing a user typing `export K=V` would see, and it
 * stays visible to later calls. `runOnce` instead passes `env` to wsl.exe as
 * the subprocess environment.
 *
 * @param {{command?: string, workdir?: string, env?: object}} req
 * @returns {string}
 */
function composeCommand(req) {
  const body = req.command === undefined || req.command === null ? '' : String(req.command)
  const prologue = []
  if (typeof req.workdir === 'string' && req.workdir !== '') {
    prologue.push('cd -- ' + shellQuote(req.workdir))
  }
  if (req.env !== undefined && req.env !== null && typeof req.env === 'object') {
    for (const [name, value] of Object.entries(req.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue
      if (value === undefined || value === null) continue
      prologue.push('export ' + name + '=' + shellQuote(String(value)))
    }
  }
  if (prologue.length === 0) return body
  // An empty command still has to apply the cd/export prologue, and a trailing
  // '&&' with nothing after it would be a syntax error.
  if (body.trim() === '') return prologue.join(' && ')
  return prologue.map((line) => line + ' || return $?').join('\n') + '\n' + body
}

/**
 * Read a whole collected stream from offset 0 (one-shot commands have no cursor
 * and are read exactly once, after the process settled).
 *
 * @param {object} handle
 * @param {'stdout'|'stderr'} channel
 * @returns {{text: string, spillPath?: string}}
 */
function readWholeStream(handle, channel) {
  const reader = handle?.collected?.[channel]
  if (reader === undefined || reader === null || typeof reader.readFrom !== 'function') return { text: '' }
  try {
    const read = reader.readFrom(0)
    if (read === undefined || read === null) return { text: '' }
    return {
      text: typeof read.text === 'string' ? read.text : '',
      lossy: read.lossy === true,
      ...(typeof read.spillPath === 'string' && read.spillPath !== '' ? { spillPath: read.spillPath } : {}),
    }
  } catch {
    return { text: '' }
  }
}

/**
 * Build the uniform RunResult object. Optional fields are omitted unless set so
 * callers can test `=== undefined` instead of falsiness.
 *
 * @param {{stdout?: string, stderr?: string, exitCode?: number|null, signal?: string|null,
 *          timedOut?: boolean, aborted?: boolean, timeoutMs?: number,
 *          shellRestarted?: boolean, spillPath?: string}} fields
 * @returns {object}
 */
function makeResult(fields) {
  const result = {
    stdout: fields.stdout ?? '',
    stderr: fields.stderr ?? '',
    exitCode: fields.exitCode === undefined ? null : fields.exitCode,
    signal: fields.signal === undefined || fields.signal === null ? null : fields.signal,
    timedOut: fields.timedOut === true,
    aborted: fields.aborted === true,
    timeoutMs: fields.timeoutMs ?? 0,
  }
  if (fields.shellRestarted === true) result.shellRestarted = true
  if (fields.truncated === true) result.truncated = true
  if (typeof fields.spillPath === 'string' && fields.spillPath !== '') result.spillPath = fields.spillPath
  return result
}

/**
 * Keep the LAST budget bytes of a string, reporting whether it dropped any.
 * @param {string} text
 * @param {number} budget
 * @returns {{text: string, truncated: boolean}}
 */
function tailBytes(text, budget) {
  const source = typeof text === 'string' ? text : ''
  if (!Number.isSafeInteger(budget) || budget <= 0) return { text: source, truncated: false }
  if (Buffer.byteLength(source, 'utf8') <= budget) return { text: source, truncated: false }
  // Cut from the front on a byte basis. A multi-byte character split by the cut
  // would decode to U+FFFD, which is dropped so the result stays clean text.
  const bytes = Buffer.from(source, 'utf8')
  const tail = bytes.subarray(bytes.length - budget).toString('utf8')
  return { text: tail.startsWith('\uFFFD') ? tail.slice(1) : tail, truncated: true }
}

/**
 * Resolve the effective deadline: the request's own timeout when it is a
 * positive integer, else the configured default. 0 means "no deadline".
 * @param {unknown} requested
 * @param {number} fallback
 * @returns {number}
 */
function resolveTimeout(requested, fallback) {
  if (Number.isSafeInteger(requested) && requested > 0) return requested
  if (Number.isSafeInteger(fallback) && fallback > 0) return fallback
  return 0
}

/**
 * A per-pool sleep. Kept as its own module function for readability; the timer
 * is intentionally not unref'd, because a pending call is real pending work.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Await `promise` but give up after `ms`, resolving whether it settled. Used to
 * keep teardown bounded when a provider can no longer observe its range.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false) } }, ms)
    Promise.resolve(promise).then(
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(true) } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false) } },
    )
  })
}

/**
 * Signal and await one subprocess handle, never letting teardown throw or hang
 * past the grace period.
 * @param {object} handle
 * @returns {Promise<void>}
 */
async function terminate(handle) {
  try {
    handle?.terminate?.()
  } catch {
    // A provider that already lost the process must not block teardown.
  }
  try {
    await settleWithin(Promise.resolve(handle?.waitForExit?.()), DEFAULT_GRACE_MS)
  } catch {
    // Nothing left to observe.
  }
}

/**
 * Reap one shell's managed range and forget it; never throws.
 * @param {object} shell
 * @returns {Promise<void>}
 */
async function reapShell(shell) {
  await terminate(shell?.handle)
}

/**
 * Whether a cancellation was already requested.
 * @param {AbortSignal|undefined|null} signal
 * @returns {boolean}
 */
function isAborted(signal) {
  return signal !== undefined && signal !== null && signal.aborted === true
}

/**
 * Read the engine's own tunables from the bridge config.
 * @param {object|undefined} config
 * @returns {object}
 */
function readSettings(config) {
  const settings = { ...DEFAULTS }
  if (config !== undefined && config !== null && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      const value = config[key]
      if (value === undefined) continue
      const fallback = DEFAULTS[key]
      if (typeof fallback === 'number') {
        if (Number.isSafeInteger(value) && value > 0) settings[key] = value
      } else if (typeof fallback === 'string') {
        if (typeof value === 'string') settings[key] = value
      } else if (value !== null && typeof value === 'string') {
        settings[key] = value
      }
    }
  }
  if (typeof settings.cwd !== 'string' || settings.cwd === '') settings.cwd = process.cwd()
  return settings
}

/**
 * Build a `(level, message)` logger from either a cordis logger object or a
 * plain function. Diagnostics must never break a call.
 * @param {object|Function|undefined} logger
 * @returns {(level: string, message: string) => void}
 */
function makeLogger(logger) {
  if (typeof logger === 'function') {
    return (level, message) => {
      try {
        logger(level, message)
      } catch {
        // diagnostics only
      }
    }
  }
  if (logger !== undefined && logger !== null && typeof logger === 'object') {
    return (level, message) => {
      try {
        const sink = logger[level] ?? logger.debug ?? logger.info
        if (typeof sink === 'function') sink.call(logger, message)
      } catch {
        // diagnostics only
      }
    }
  }
  return () => {}
}

/**
 * Coerce an unknown value to a finite number or null.
 * @param {unknown} value
 * @returns {number|null}
 */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Human-readable message for an unknown thrown value.
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
