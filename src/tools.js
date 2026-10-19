/**
 * The six model-facing tools.
 *
 * Every tool returns the SAME result envelope `{ text, exitCode, timedOut,
 * truncated, aborted }` and renders `text`; the schema is hand-written JSON
 * Schema because the plugin is zero-dependency (see index.js). `wsl_bash` uses
 * the terminal presentation card with the host's `[exit code: N]` marker so the
 * UI's exit pill works, exactly like the shipped bash tool.
 *
 * @module dsh-wsl-bridge/tools
 */
import { editText, readText, writeText } from './fsops.js'
import { checkDangerous } from './guard.js'
import { startWslBackgroundJob } from './jobs.js'
import {
  ensureLinuxPath, isWindowsPath, linuxPathToWindows, toLinuxWorkdir, windowsPathToLinux,
} from './paths.js'

/** Uniform result schema (the DSH output-schema check only needs a supported subset). */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: 'Model-facing rendering of the result.' },
    exitCode: { type: 'number', description: 'Process exit code; a transport failure reports -1.' },
    timedOut: { type: 'boolean' },
    truncated: { type: 'boolean' },
    aborted: { type: 'boolean' },
  },
  required: ['text', 'exitCode', 'timedOut', 'truncated', 'aborted'],
}

/**
 * Build one result envelope.
 * @param {{text: string, exitCode?: number, timedOut?: boolean, truncated?: boolean, aborted?: boolean}} input
 * @returns {{text: string, exitCode: number, timedOut: boolean, truncated: boolean, aborted: boolean}}
 */
export function envelope({ text, exitCode = 0, timedOut = false, truncated = false, aborted = false }) {
  return { text, exitCode, timedOut, truncated, aborted }
}

/** Render hook shared by every tool. */
export const renderEnvelope = (_args, value) => [{ type: 'text', text: String(value.text ?? '') }]

/**
 * The execution's owning agent, used as the persistent-shell key.
 * @param {object|undefined} exec
 * @returns {object}
 */
export function agentKey(exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) {
    throw new Error('the wsl tools need an owning agent session: the bridge keeps one shell per session')
  }
  return agent
}

/**
 * Clamp a requested timeout to the supported window.
 * @param {unknown} requested
 * @param {number} fallback
 * @returns {number}
 */
export function clampTimeout(requested, fallback) {
  if (requested === undefined || requested === null) return fallback
  if (!Number.isFinite(requested)) return fallback
  return Math.min(Math.max(Math.trunc(requested), 1_000), 24 * 60 * 60 * 1000)
}

/**
 * Format a shell run the way the model and the terminal card expect.
 * @param {object} result - RunResult from the shell pool.
 * @param {number} timeoutMs - the deadline actually requested.
 * @returns {string}
 */
export function formatRun(result, timeoutMs) {
  const parts = []
  if (typeof result.stdout === 'string' && result.stdout !== '') {
    parts.push(result.stdout.replace(/\n$/u, ''))
  }
  if (typeof result.stderr === 'string' && result.stderr !== '') {
    parts.push('[stderr]\n' + result.stderr.replace(/\n$/u, ''))
  }
  if (result.timedOut === true) {
    parts.push('[timed out after ' + String(result.timeoutMs ?? timeoutMs) + 'ms; the command was killed]')
  } else if (result.aborted === true) {
    parts.push('[aborted]')
  } else if (typeof result.signal === 'string' && result.signal !== '') {
    parts.push('[killed by signal: ' + result.signal + ']')
  }
  parts.push('[exit code: ' + String(result.exitCode ?? -1) + ']')
  if (result.shellRestarted === true) {
    parts.push('[note: the previous persistent shell had exited; a new shell was started, so earlier `cd`/exports are gone]')
  }
  if (typeof result.spillPath === 'string' && result.spillPath !== '') {
    parts.push('[output truncated; full output: ' + result.spillPath + ']')
  }
  return parts.filter((part) => part !== '').join('\n')
}

/**
 * Build all tool definitions for this mount.
 *
 * @param {{pool: object, config: object}} deps
 * @returns {object[]}
 */
export function buildTools({ pool, config, subprocess, jobs }) {
  return [
    bashTool({ pool, config, subprocess, jobs }),
    readTool({ pool, config }),
    writeTool({ pool, config }),
    editTool({ pool, config }),
    pathTool({ pool, config }),
    envTool({ pool, config }),
  ]
}

/**
 * Register a background command and return the envelope that names its job id.
 * @param {{config: object, subprocess: object|undefined, jobs: object|undefined,
 *          exec: object|undefined, command: string, workdir: string|undefined, label: string}} request
 * @returns {object}
 */
export function startBackground({ config, subprocess, jobs, exec, command, workdir, label }) {
  if (config.backgroundJobs !== true) {
    return envelope({ exitCode: 1, text: 'BACKGROUND_DISABLED: background jobs are disabled for this deployment (backgroundJobs: false).' })
  }
  if (jobs === undefined || subprocess === undefined) {
    return envelope({
      exitCode: 1,
      text: 'BACKGROUND_UNAVAILABLE: this deployment composes no background job registry (ctx.jobs), so the command was not started. Run it without runInBackground.',
    })
  }
  const owner = exec?.agent?.id
  try {
    const jobId = startWslBackgroundJob({
      subprocess, jobs, config, owner, script: command, label, workdir,
    })
    return envelope({
      text: 'Started background job ' + jobId + '. Read it with job_output and stop it with job_kill.'
        + ' It runs in its own WSL process, so this session\'s persistent shell cd/exports do not apply.',
    })
  } catch (error) {
    return envelope({ exitCode: 1, text: 'BACKGROUND_FAILED: ' + (error instanceof Error ? error.message : String(error)) })
  }
}

/** `wsl_bash` — persistent Linux shell, one per session. */
function bashTool({ pool, config, subprocess, jobs }) {
  return {
    name: 'wsl_bash',
    description: [
      'Run a bash command inside the WSL Linux distribution on this Windows host.',
      'It is a real Linux kernel and bash — not PowerShell: send bash syntax.',
      'The shell is persistent per session: `cd`, exported variables and functions',
      'survive between calls, so use absolute paths or an explicit `cd` when you need',
      'a known directory. Use runInBackground for long-running background work.',
      'stdout and stderr are returned, followed by `[exit code: N]`.',
      'The working directory defaults to the session directory translated to',
      '`/mnt/<drive>/...`; pass `workdir` to change it.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Bash command to run inside WSL.' },
        description: { type: 'string', description: 'Short human label for this call.' },
        workdir: {
          type: 'string',
          description: 'Linux working directory for this call and the rest of the session; a Windows path is translated.',
        },
        timeoutMs: { type: 'number', description: 'Deadline in milliseconds (default ' + String(config.timeoutMs) + ').' },
        allowDangerous: {
          type: 'boolean',
          description: 'Set true to run a destructive command (recursive delete, device write, power control).',
        },
        runInBackground: {
          type: 'boolean',
          description: 'Start the command as a host background job and return its id (read with job_output, stop with job_kill). The job gets its own WSL process, so persistent-shell cd/exports do not apply.',
        },
      },
      required: ['command', 'description'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    presentCall: (args) => ({ card: 'terminal', title: String(args.description ?? 'WSL bash'), cwd: args.workdir }),
    presentResult: (_args, value) => ({ card: 'terminal', output: value.text, exitCode: value.exitCode }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const key = agentKey(exec)
      const command = String(args.command)
      if (config.dangerGuard) {
        const danger = checkDangerous(command)
        if (danger !== null && args.allowDangerous !== true) {
          return envelope({
            exitCode: 1,
            text: '[blocked] ' + danger + '. Nothing ran. Pass allowDangerous: true only if this is intended.',
          })
        }
      }
      // A persistent shell keeps its cwd: pass an explicit workdir every time,
      // but the session default only as the shell's initial directory.
      const explicit = typeof args.workdir === 'string' && args.workdir !== ''
      const workdir = explicit
        ? toLinuxWorkdir(args.workdir, exec, config)
        : (args.runInBackground !== true && typeof pool.has === 'function' && pool.has(key) ? undefined : toLinuxWorkdir(undefined, exec, config))
      const timeoutMs = clampTimeout(args.timeoutMs, config.timeoutMs)
      if (args.runInBackground === true) {
        return startBackground({ config, subprocess, jobs, exec, command, workdir, label: String(args.description ?? command) })
      }
      const result = await pool.run(key, {
        command,
        workdir,
        timeoutMs,
        signal: exec?.signal,
      })
      return envelope({
        text: formatRun(result, timeoutMs),
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
        timedOut: result.timedOut === true,
        truncated: typeof result.spillPath === 'string' && result.spillPath !== '',
        aborted: result.aborted === true,
      })
    },
  }
}

/** `wsl_read` — read a Linux path. */
function readTool({ pool, config }) {
  return {
    name: 'wsl_read',
    description: [
      'Read a text file from the WSL Linux filesystem by absolute Linux path',
      '(for example `/home/me/project/src/app.js`). A Windows path is translated.',
      '`offset` (0-based) and `limit` select a line window; the default reads the',
      'whole file up to the configured size cap.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute Linux path to read.' },
        offset: { type: 'number', description: '0-based first line to return.' },
        limit: { type: 'number', description: 'Maximum number of lines to return.' },
      },
      required: ['path'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args) {
      const path = ensureLinuxPath(args.path)
      const original = await readText(pool, { path, maxBytes: config.maxFileBytes, timeoutMs: config.fileTimeoutMs })
      let text = original.text
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = text.split('\n')
        const offset = Math.max(0, Math.trunc(Number(args.offset ?? 0)))
        const limit = args.limit === undefined ? lines.length : Math.max(0, Math.trunc(Number(args.limit)))
        text = lines.slice(offset, offset + limit).join('\n')
      }
      if (original.truncated) {
        text += '\n[truncated: file is larger than ' + String(config.maxFileBytes)
          + ' bytes; read it in WSL with `wsl_bash` instead]'
      }
      return envelope({ text, truncated: original.truncated })
    },
  }
}

/** `wsl_write` — atomic write with optional sha256 fence. */
function writeTool({ pool, config }) {
  return {
    name: 'wsl_write',
    description: [
      'Create or overwrite a text file on the WSL side, atomically, by absolute',
      'Linux path. Pass `expectedSha256` to refuse the write when the file changed',
      'since you read it (the stale-write fence). Parent directories are not created',
      'automatically; create them with `wsl_bash` when needed.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute Linux path to write.' },
        content: { type: 'string', description: 'Full file content (UTF-8).' },
        expectedSha256: { type: 'string', description: 'Refuse the write unless the current file has this sha256.' },
      },
      required: ['path', 'content'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args) {
      const path = ensureLinuxPath(args.path)
      const written = await writeText(pool, {
        path,
        text: String(args.content),
        expectedSha256: typeof args.expectedSha256 === 'string' ? args.expectedSha256 : '',
        timeoutMs: config.fileTimeoutMs,
      })
      if (!written.ok) {
        return envelope({
          exitCode: 1,
          text: '[stale] ' + path + ' changed since it was read (current sha256: '
            + (written.current === '' ? 'missing' : written.current) + '); re-read it and retry.',
        })
      }
      return envelope({ text: 'Wrote ' + String(written.bytes) + ' bytes to ' + path + '\nsha256: ' + written.sha256 })
    },
  }
}

/** `wsl_edit` — string replacement under a sha256 fence. */
function editTool({ pool, config }) {
  return {
    name: 'wsl_edit',
    description: [
      'Replace a string in a file on the WSL side by absolute Linux path.',
      '`oldString` must be unique unless `replaceAll` is true. The read-modify-write',
      'uses a best-effort sha256 check before rename to detect stale content.',
      'Avoid concurrent external writes; this is not an atomic compare-and-swap.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute Linux path to edit.' },
        oldString: { type: 'string', description: 'Exact text to replace (must occur once unless replaceAll).' },
        newString: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args) {
      const path = ensureLinuxPath(args.path)
      const edited = await editText(pool, {
        path,
        oldString: String(args.oldString),
        newString: String(args.newString),
        replaceAll: args.replaceAll === true,
        maxBytes: config.maxFileBytes,
        timeoutMs: config.fileTimeoutMs,
      })
      if (!edited.ok) {
        return envelope({
          exitCode: 1,
          text: '[stale] ' + path + ' changed since it was read (current sha256: '
            + (edited.current === '' ? 'missing' : edited.current) + '); re-read it and retry.',
        })
      }
      return envelope({
        text: 'Edited ' + path + ' (' + String(edited.replacements) + ' replacement'
          + (edited.replacements === 1 ? '' : 's') + ')\nsha256: ' + edited.sha256,
      })
    },
  }
}

/** `wsl_path` — convert between Windows and Linux spellings. */
function pathTool({ pool, config }) {
  return {
    name: 'wsl_path',
    description: [
      'Convert a path between its Windows spelling (`C:\\Users\\...`, or the',
      '`\\\\wsl.localhost\\<distro>\\...` UNC form) and its WSL Linux spelling',
      '(`/mnt/c/Users/...`). Direction is auto-detected from the input; force it',
      'with `direction`.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'The path to convert.' },
        direction: { type: 'string', enum: ['auto', 'linux', 'win'], description: 'Target spelling; default auto.' },
      },
      required: ['path'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args) {
      const input = String(args.path)
      const direction = args.direction === 'linux' || args.direction === 'win' ? args.direction : 'auto'
      const toLinux = direction === 'auto'
        ? (isWindowsPath(input) || !input.startsWith('/'))
        : direction === 'linux'

      let output = null
      try {
        const result = await pool.runOnce({
          command: toLinux
            ? 'wslpath -a -u -- ' + quote(input)
            : 'wslpath -a -w -- ' + quote(input),
          timeoutMs: config.fileTimeoutMs,
        })
        if (result.exitCode === 0 && result.stdout.trim() !== '') output = result.stdout.trim()
      } catch {
        // fall through to the pure mapping
      }
      if (output === null) {
        output = toLinux
          ? windowsPathToLinux(input)
          : linuxPathToWindows(input, config.distro)
      }
      if (output === null) {
        return envelope({ exitCode: 1, text: 'Cannot convert "' + input + '" (' + (toLinux ? 'to Linux' : 'to Windows') + ').' })
      }
      return envelope({ text: input + '  ->  ' + output })
    },
  }
}

/** `wsl_env` — what the distribution can actually do. */
function envTool({ pool, config }) {
  return {
    name: 'wsl_env',
    description: [
      'Report the WSL distribution this session uses: distro name, kernel, user,',
      'home, current directory, and whether node / pnpm / python3 / git are',
      'installed inside it, plus the Windows drives mounted under /mnt. Read-only;',
      'run it before blaming a command on the command.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute() {
      const script = [
        'echo "distro=${WSL_DISTRO_NAME:-（unknown）}"',
        'echo "kernel=$(uname -sr)"',
        'echo "user=$(id -un)"',
        'echo "home=$HOME"',
        'echo "cwd=$PWD"',
        'echo "node=$(node -v 2>/dev/null || echo missing)"',
        'echo "pnpm=$(pnpm -v 2>/dev/null || echo missing)"',
        'echo "python3=$(python3 -V 2>/dev/null || echo missing)"',
        'echo "git=$(git --version 2>/dev/null || echo missing)"',
        'echo "mounts=$(ls -d /mnt/* 2>/dev/null | tr "\\n" ",")"',
      ].join('; ')
      const result = await pool.runOnce({ command: script, timeoutMs: config.fileTimeoutMs })
      const text = [result.stdout.trim(), result.stderr.trim()].filter((part) => part !== '').join('\n')
      return envelope({
        text: text === '' ? '[exit code: ' + String(result.exitCode) + ']' : text + '\n[exit code: ' + String(result.exitCode) + ']',
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
      })
    },
  }
}

/**
 * Single-quote a value for bash.
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return "'" + String(value).replace(/'/gu, "'\\''") + "'"
}
