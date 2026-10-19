/**
 * Fake `ctx.subprocess.spawn` for unit tests: a controllable handle that mimics
 * the real seam's observable surface, plus two scripted behaviours — one for the
 * persistent `bash -l -s` shell (which answers wire-protocol frames) and one for
 * one-shot `bash -lc` commands.
 *
 * The real seam's relevant surface, as used by src/shell.js and verified against
 * `@linxin666/dsh-win-bash` on DSH 0.2.1:
 *
 *   handle.done                     -> Promise<{exitCode, signal}>
 *   handle.collected.stdout.readFrom(offset)
 *                                   -> {text, nextOffset, lossy, spillPath?}
 *   handle.stdin.write(text)        -> void    (when stdin is 'pipe')
 *   handle.terminate()              -> void
 *   handle.waitForExit()            -> Promise<void>
 *
 * The collected readers are offset based and NON consuming, so the fake keeps
 * the whole byte stream and hands out a slice from the requested byte offset.
 *
 * Nothing here talks to a real process: no WSL, no MSYS2, no child_process. That
 * is deliberate — the DSH sandbox refuses piped child stdio (EPERM), and the WSL
 * probe is somebody else's test.
 *
 * @module test/fake-subprocess
 */
import { Buffer } from 'node:buffer'
import {
  BEGIN_TAG,
  END_TAG,
  MARKER_PREFIX,
  MARKER_SUFFIX,
  STATUS_VAR,
} from '../src/protocol.js'

/**
 * One fake subprocess handle. Tests may push output, settle the exit or inspect
 * the captured argv/stdio by reaching through `handle` (the object shell.js
 * sees) and the fields kept on this record.
 */
export class FakeHandle {
  /**
   * @param {object} spawnOptions - the options object passed to `spawn`.
   * @param {'shell'|'once'} kind
   */
  constructor(spawnOptions, kind) {
    /** The exact options object the pool passed to spawn. */
    this.spawnOptions = spawnOptions ?? {}
    this.kind = kind
    this.argv = Array.isArray(this.spawnOptions.argv) ? [...this.spawnOptions.argv] : []
    this.cwd = this.spawnOptions.cwd
    this.env = this.spawnOptions.env
    /** Raw stdio config, so tests can assert the stdin data shape. */
    this.stdio = this.spawnOptions.stdio ?? {}
    const stdin = this.stdio.stdin ?? 'ignore'
    this.stdinMode = typeof stdin === 'object' && stdin !== null ? 'data' : stdin
    this.stdinData = typeof stdin === 'object' && stdin !== null && 'data' in stdin
      ? String(stdin.data)
      : undefined
    /** Every stdin write the pool made (persistent frames). */
    this.stdinWrites = []
    this.stdinEnded = false
    /** Whole captured streams; readers slice them by byte offset. */
    this.stdoutBuffer = Buffer.alloc(0)
    this.stderrBuffer = Buffer.alloc(0)
    this.exitCode = null
    this.signal = null
    this.terminated = false
    this.exitCalled = false
    /** Parsed wire frames (persistent shell only). */
    this.frames = []
    /** Payloads that did not look like a frame (a protocol bug indicator). */
    this.parseErrors = []
    /** Resolver of the done promise. */
    this._settle = undefined
    this.done = new Promise((resolve) => { this._settle = resolve })
    // Never let an unobserved rejection surface from a test helper.
    this.done.then(() => undefined, () => undefined)
    this.collected = {
      stdout: { readFrom: (offset) => this.readFrom('stdout', offset) },
      stderr: { readFrom: (offset) => this.readFrom('stderr', offset) },
    }
    this.handle = {
      argv: this.argv,
      done: this.done,
      stdin: this.stdinMode === 'pipe'
        ? {
            write: (text) => {
              this.stdinWrites.push(String(text))
              this.onStdin?.(String(text))
            },
            end: () => { this.stdinEnded = true },
          }
        : undefined,
      collected: this.collected,
      terminate: () => {
        this.terminated = true
        this.exit(null, 'SIGTERM')
      },
      waitForExit: () => this.done.then(() => undefined, () => undefined),
    }
  }

  /** True once the process settled (by exit or by terminate). */
  get exited() {
    return this.exitCalled
  }

  /**
   * Append bytes to one captured stream.
   * @param {'stdout'|'stderr'} channel
   * @param {string} text
   */
  write(channel, text) {
    if (text === '') return
    const buffer = Buffer.from(String(text), 'utf8')
    if (channel === 'stderr') this.stderrBuffer = Buffer.concat([this.stderrBuffer, buffer])
    else this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, buffer])
  }

  /**
   * Non-consuming offset read, exactly like the seam's collected reader.
   * @param {'stdout'|'stderr'} channel
   * @param {number} offset - byte offset into the whole stream.
   * @returns {{text: string, nextOffset: number, lossy: boolean}}
   */
  readFrom(channel, offset) {
    const buffer = channel === 'stderr' ? this.stderrBuffer : this.stdoutBuffer
    const start = Number.isSafeInteger(offset) && offset > 0
      ? Math.min(offset, buffer.length)
      : 0
    return {
      text: buffer.subarray(start).toString('utf8'),
      nextOffset: buffer.length,
      lossy: false,
    }
  }

  /**
   * Settle the process with an exit status.
   * @param {number|null} code
   * @param {string|null} [signal]
   */
  exit(code, signal = null) {
    if (this.exitCalled) return
    this.exitCalled = true
    this.exitCode = code
    this.signal = signal
    this._settle({ exitCode: code, signal })
  }
}

/**
 * Create a fake subprocess seam.
 *
 * @param {{
 *   shell?: (command: string, context: object) => object|Promise<object>,
 *   once?: (command: string, context: object) => object|Promise<object>,
 *   chunkSize?: number,
 *   chunkDelayMs?: number,
 *   spawnError?: Error,
 * }} [options]
 *   `shell` answers a persistent-shell frame with
 *   `{stdout?, stderr?, exitCode?, hang?, shellExit?}`; `once` answers a
 *   one-shot command the same way (`shellExit` is meaningless there).
 *   `chunkSize`/`chunkDelayMs` split every response into small delayed writes so
 *   the frame parser really sees split markers and status digits.
 * @returns {{
 *   spawn: (spawnOptions: object) => object,
 *   calls: object[],
 *   handles: FakeHandle[],
 *   lastHandle: () => (FakeHandle|null),
 *   shellHandles: () => FakeHandle[],
 *   onceHandles: () => FakeHandle[],
 *   size: number,
 * }}
 */
export function createFakeSubprocess(options = {}) {
  const settings = {
    shell: typeof options.shell === 'function' ? options.shell : () => ({ stdout: '', stderr: '', exitCode: 0 }),
    once: typeof options.once === 'function' ? options.once : () => ({ stdout: '', stderr: '', exitCode: 0 }),
    chunkSize: Number.isSafeInteger(options.chunkSize) && options.chunkSize > 0 ? options.chunkSize : 0,
    chunkDelayMs: Number.isSafeInteger(options.chunkDelayMs) && options.chunkDelayMs >= 0
      ? options.chunkDelayMs
      : 0,
    spawnError: options.spawnError,
  }
  /** The options object of every spawn call, in order. */
  const calls = []
  /** Every FakeHandle, in spawn order. */
  const handles = []

  /** @param {object} spawnOptions */
  function spawn(spawnOptions) {
    if (settings.spawnError !== undefined) throw settings.spawnError
    const argv = Array.isArray(spawnOptions?.argv) ? spawnOptions.argv : []
    const kind = argv.includes('-s') ? 'shell' : 'once'
    const record = new FakeHandle(spawnOptions, kind)
    calls.push(spawnOptions)
    handles.push(record)
    const index = handles.length - 1
    if (kind === 'shell') scriptShell(record, index)
    else scriptOnce(record, index)
    return record.handle
  }

  /**
   * Wire the persistent-shell behaviour: every stdin frame is parsed and
   * answered with framed stdout/stderr and an exit status, without the shell
   * process ending.
   * @param {FakeHandle} record
   * @param {number} index
   */
  function scriptShell(record, index) {
    let call = 0
    record.onStdin = (payload) => {
      const frame = parseFramePayload(payload)
      if (frame === null) {
        record.parseErrors.push(payload)
        return
      }
      record.frames.push(frame)
      const context = { argv: record.argv, handle: record.handle, record, frame, call, spawnIndex: index }
      call += 1
      let result
      try {
        result = settings.shell(frame.command, context)
      } catch (error) {
        result = { error }
      }
      if (result !== undefined && result !== null && typeof result.then === 'function') {
        result.then((value) => respondShell(record, frame, value), (error) => respondShell(record, frame, { error }))
      } else {
        respondShell(record, frame, result)
      }
    }
  }

  /**
   * Emit one framed answer on a persistent shell. The shell stays alive.
   * @param {FakeHandle} record
   * @param {object} frame
   * @param {object|undefined|null} result
   */
  function respondShell(record, frame, result) {
    const answer = normalise(result)
    if (answer === null) return
    if (answer.hang === true) {
      // A wedged command still printed its begin marker (and maybe some output)
      // before it stopped; only the end marker never arrives.
      emitAll(record, [
        ...(answer.stderr === '' ? [] : [{ channel: 'stderr', text: answer.stderr }]),
        { channel: 'stdout', text: '\n' + frame.begin + '\n' + answer.stdout },
      ], () => {})
      return
    }
    if (answer.shellExit === true) {
      record.exit(answer.exitCode, answer.signal ?? null)
      return
    }
    const frameText = '\n' + frame.begin + '\n'
      + answer.stdout
      + '\n' + frame.end + String(answer.exitCode) + '\n'
    emitAll(record, [
      ...(answer.stderr === '' ? [] : [{ channel: 'stderr', text: answer.stderr }]),
      { channel: 'stdout', text: frameText },
    ], () => {})
  }

  /**
   * Wire the one-shot behaviour: answer the command (if scripted) and exit.
   * @param {FakeHandle} record
   * @param {number} index
   */
  function scriptOnce(record, index) {
    const command = record.argv[record.argv.length - 1]
    const context = { argv: record.argv, handle: record.handle, record, command, spawnIndex: index }
    let result
    try {
      result = settings.once(command, context)
    } catch (error) {
      result = { error }
    }
    const finish = (value) => respondOnce(record, value)
    if (result !== undefined && result !== null && typeof result.then === 'function') {
      result.then(finish, (error) => finish({ error }))
    } else finish(result)
  }

  /**
   * Emit a one-shot command's result and settle the process.
   * @param {FakeHandle} record
   * @param {object|undefined|null} result
   */
  function respondOnce(record, result) {
    const answer = normalise(result)
    if (answer === null) return
    if (answer.hang === true) return
    emitAll(record, [
      ...(answer.stderr === '' ? [] : [{ channel: 'stderr', text: answer.stderr }]),
      ...(answer.stdout === '' ? [] : [{ channel: 'stdout', text: answer.stdout }]),
    ], () => record.exit(answer.exitCode, answer.signal ?? null))
  }

  /**
   * Emit several texts with the configured chunking, then call `final`.
   * @param {FakeHandle} record
   * @param {{channel: string, text: string}[]} items
   * @param {() => void} final
   */
  function emitAll(record, items, final) {
    if (items.length === 0) { final(); return }
    let pending = items.length
    for (const item of items) {
      emitText(record, item.channel, item.text, () => {
        pending -= 1
        if (pending === 0) final()
      })
    }
  }

  /**
   * Emit one text, split by `chunkSize` and paced by `chunkDelayMs`.
   * @param {FakeHandle} record
   * @param {'stdout'|'stderr'} channel
   * @param {string} text
   * @param {() => void} done
   */
  function emitText(record, channel, text, done) {
    if (text === '') { done(); return }
    const pieces = []
    if (settings.chunkSize <= 0) pieces.push(text)
    else {
      for (let index = 0; index < text.length; index += settings.chunkSize) {
        pieces.push(text.slice(index, index + settings.chunkSize))
      }
    }
    let index = 0
    const pump = () => {
      if (index >= pieces.length) { done(); return }
      record.write(channel, pieces[index])
      index += 1
      if (settings.chunkDelayMs > 0) setTimeout(pump, settings.chunkDelayMs)
      else setImmediate(pump)
    }
    if (settings.chunkDelayMs > 0) setTimeout(pump, settings.chunkDelayMs)
    else setImmediate(pump)
  }

  return {
    spawn,
    calls,
    handles,
    lastHandle: () => (handles.length === 0 ? null : handles[handles.length - 1]),
    shellHandles: () => handles.filter((handle) => handle.kind === 'shell'),
    onceHandles: () => handles.filter((handle) => handle.kind === 'once'),
    get size() {
      return handles.length
    },
  }
}

/**
 * Parse one wire-protocol payload written to the persistent shell's stdin.
 *
 * Mirrors what bash does with the frame: the command is every line between the
 * heredoc opener and the nonce-bearing delimiter. A payload that does not match
 * means src/protocol.js and this fake disagree, which is exactly the bug the
 * framing unit tests exist to catch.
 *
 * @param {string} payload
 * @returns {{begin: string, end: string, nonce: string, command: string, payload: string}|null}
 */
export function parseFramePayload(payload) {
  if (typeof payload !== 'string' || payload === '') return null
  const beginMatch = new RegExp(
    escapeRegExp(MARKER_PREFIX + BEGIN_TAG) + '([0-9A-Za-z]+)' + escapeRegExp(MARKER_SUFFIX),
    'u',
  ).exec(payload)
  if (beginMatch === null) return null
  const begin = beginMatch[0]
  const nonce = beginMatch[1]
  const end = MARKER_PREFIX + END_TAG + nonce + MARKER_SUFFIX
  const lines = payload.split('\n')
  const opener = ". /dev/stdin <<'" + end + "'"
  const openerIndex = lines.indexOf(opener)
  if (openerIndex < 0) return null
  const endIndex = lines.indexOf(end, openerIndex + 1)
  if (endIndex < 0) return null
  if (!lines.includes(STATUS_VAR + '=$?')) return null
  const command = lines.slice(openerIndex + 1, endIndex).join('\n')
  return { begin, end, nonce, command, payload }
}

/**
 * Normalise a scripted handler result into the fields the emitter understands.
 * @param {object|undefined|null} result
 * @returns {{stdout: string, stderr: string, exitCode: number, hang: boolean,
 *            shellExit: boolean, signal: string|null}|null}
 */
function normalise(result) {
  if (result === undefined || result === null) {
    return { stdout: '', stderr: '', exitCode: 0, hang: false, shellExit: false, signal: null }
  }
  if (typeof result !== 'object') {
    return { stdout: String(result), stderr: '', exitCode: 0, hang: false, shellExit: false, signal: null }
  }
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : 0,
    hang: result.hang === true,
    shellExit: result.shellExit === true,
    signal: typeof result.signal === 'string' ? result.signal : null,
  }
}

/**
 * Escape a literal string for use inside a RegExp.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
