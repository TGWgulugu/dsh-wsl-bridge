/**
 * Tools for the `WSL` agent preset: the same WSL execution surface as the
 * host-wide `wsl_*` tools, but registered under the names a session expects
 * from its own world (`bash`, `read`, `write`, `edit`, `grep`, `glob`).
 *
 * The preset mounts this module as `dsh-wsl-bridge/wsl-world`; nothing here is
 * registered globally, so a WSL session gets these names while a normal
 * Windows session keeps the host's own tools untouched.
 *
 * @module dsh-wsl-bridge/world-tools
 */
import { editText, readText, writeText } from './fsops.js'
import { checkDangerous } from './guard.js'
import { startBackground } from './tools.js'
import { ensureLinuxPath, isWindowsPath, toLinuxWorkdir } from './paths.js'
import { globFiles, grepFiles, renderGlob, renderGrep } from './search.js'
import {
  agentKey, clampTimeout, envelope, formatRun, renderEnvelope,
} from './tools.js'

/** Same uniform envelope as the host-wide tools. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    exitCode: { type: 'number' },
    timedOut: { type: 'boolean' },
    truncated: { type: 'boolean' },
    aborted: { type: 'boolean' },
  },
  required: ['text', 'exitCode', 'timedOut', 'truncated', 'aborted'],
}

/**
 * Phrase used in tool descriptions for the configured default workspace.
 * @param {object} config
 * @returns {string}
 */
function workspaceLabel(config) {
  if (config.defaultWorkdir === 'home') return 'the WSL home directory'
  if (config.defaultWorkdir === '' || config.defaultWorkdir === 'session') return 'the session directory'
  return config.defaultWorkdir
}

/**
 * Resolve `defaultWorkdir: 'home'` to the current distribution's `$HOME`.
 *
 * The lookup runs once per tool set, and only when a call actually needs the
 * default (omitted or relative path). An absolute Linux path or a Windows path
 * does not spawn WSL. Login profiles may print to stdout, so the value is taken
 * from a marker line rather than the whole stream.
 *
 * @param {object} pool
 * @param {object} config
 * @returns {(pathValue: unknown) => Promise<object>}
 */
function createWorkspace(pool, config) {
  /** @type {Promise<string>|undefined} */
  let pending
  return async function workspaceFor(pathValue) {
    if (config.defaultWorkdir !== 'home') return config
    if (typeof pathValue === 'string' && pathValue !== ''
      && (isWindowsPath(pathValue) || pathValue.startsWith('/'))) {
      return config
    }
    pending ??= readWslHome(pool, config).catch((error) => {
      pending = undefined
      throw error
    })
    return { ...config, defaultWorkdir: await pending }
  }
}

/**
 * @param {object} pool
 * @param {object} config
 * @returns {Promise<string>}
 */
async function readWslHome(pool, config) {
  const result = await pool.runOnce({
    command: "printf '\\n__WSL_HOME__%s\\n' \"$HOME\"",
    timeoutMs: config.fileTimeoutMs,
  })
  const matches = [...String(result.stdout ?? '').matchAll(/__WSL_HOME__([^\r\n]*)/gu)]
  const home = matches.length === 0 ? '' : matches[matches.length - 1][1]
  if (result.timedOut === true || result.aborted === true || result.exitCode !== 0
    || !home.startsWith('/') || home.includes('\0')) {
    const detail = String(result.stderr ?? '').trim()
    throw new Error('could not resolve the WSL home directory' + (detail === '' ? '' : ': ' + detail))
  }
  return home
}

/**
 * Resolve a tool path: Windows paths are translated, absolute Linux paths are
 * used as given, and relative paths resolve against the default workspace
 * (the session directory, or `$HOME` after `workspaceFor` has filled it in).
 *
 * @param {unknown} value - the call's `path` argument.
 * @param {object|undefined} exec - tool execution facts.
 * @param {object} config - resolved config.
 * @returns {string}
 */
export function resolveWorldPath(value, exec, config) {
  if (typeof value !== 'string' || value === '') throw new Error('path is required')
  if (isWindowsPath(value) || value.startsWith('/')) return ensureLinuxPath(value)
  const workdir = toLinuxWorkdir(undefined, exec, config)
  if (workdir === undefined || workdir === '') {
    throw new Error('relative path "' + value + '" needs a working directory; pass an absolute Linux path')
  }
  return ensureLinuxPath(workdir.replace(/\/+$/u, '') + '/' + value.replace(/^\.\//u, ''))
}

/**
 * Build the preset-scope tool set.
 *
 * @param {{pool: object, config: object}} deps
 * @returns {object[]}
 */
export function buildWorldTools({ pool, config, subprocess, jobs }) {
  const workspaceFor = createWorkspace(pool, config)
  const where = workspaceLabel(config)
  return [
    bashTool({ pool, config, subprocess, jobs, workspaceFor, where }),
    readTool({ pool, config, workspaceFor, where }),
    writeTool({ pool, config, workspaceFor, where }),
    editTool({ pool, config, workspaceFor }),
    grepTool({ pool, config, workspaceFor, where }),
    globTool({ pool, config, workspaceFor, where }),
    envTool({ pool, config }),
  ]
}

/** `bash` - persistent bash inside the WSL distribution. */
function bashTool({ pool, config, subprocess, jobs, workspaceFor, where }) {
  return {
    name: 'bash',
    description: [
      'Run a bash command inside the WSL Linux distribution that holds this session.',
      'It is a real Linux kernel and bash, not PowerShell: send bash syntax.',
      'The shell is persistent per session: `cd`, exported variables and functions',
      'survive between calls, so use absolute paths or an explicit `cd`.',
      'The first command starts in ' + where + ' unless `workdir` is set.',
      'Everything this session touches is a Linux path; Windows files are reachable',
      'as `/mnt/<drive>/...`. stdout and stderr are followed by `[exit code: N]`.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Bash command to run inside WSL.' },
        description: { type: 'string', description: 'Short human label for this call.' },
        workdir: { type: 'string', description: 'Linux working directory for this call and the rest of the session.' },
        timeoutMs: { type: 'number', description: 'Deadline in milliseconds (default ' + String(config.timeoutMs) + ').' },
        allowDangerous: {
          type: 'boolean',
          description: 'Set true to run a destructive command (recursive delete, device write, power control).',
        },
        runInBackground: {
          type: 'boolean',
          description: 'Start the command as a host background job and return its id (read with job_output, stop with job_kill).',
        },
      },
      required: ['command', 'description'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    presentCall: (args) => ({ card: 'terminal', title: String(args.description ?? 'bash'), cwd: args.workdir }),
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
      // Explicit workdir wins. The default workspace is only the shell's initial
      // directory; a shell that already exists keeps its own cwd.
      const explicit = typeof args.workdir === 'string' && args.workdir !== ''
      const shellReady = args.runInBackground !== true && typeof pool.has === 'function' && pool.has(key)
      const active = shellReady && !explicit ? config : await workspaceFor(explicit ? args.workdir : undefined)
      const workdir = explicit
        ? toLinuxWorkdir(args.workdir, exec, active)
        : (shellReady ? undefined : toLinuxWorkdir(undefined, exec, active))
      const timeoutMs = clampTimeout(args.timeoutMs, config.timeoutMs)
      if (args.runInBackground === true) {
        return startBackground({ config, subprocess, jobs, exec, command, workdir, label: String(args.description ?? command) })
      }
      const result = await pool.run(key, {
        command, workdir, timeoutMs, signal: exec?.signal,
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

/** `read` - read a Linux path. */
function readTool({ pool, config, workspaceFor, where }) {
  return {
    name: 'read',
    description: [
      'Read a text file by Linux path (for example `/home/me/project/app.js`).',
      'Relative paths resolve against ' + where + '; Windows paths are',
      'translated. `offset` (0-based) and `limit` select a line window.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Linux path to read.' },
        offset: { type: 'number', description: '0-based first line to return.' },
        limit: { type: 'number', description: 'Maximum number of lines to return.' },
      },
      required: ['path'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const active = await workspaceFor(args.path)
      const path = resolveWorldPath(args.path, exec, active)
      const original = await readText(pool, { path, maxBytes: config.maxFileBytes, timeoutMs: config.fileTimeoutMs })
      let text = original.text
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = text.split('\n')
        const offset = Math.max(0, Math.trunc(Number(args.offset ?? 0)))
        const limit = args.limit === undefined ? lines.length : Math.max(0, Math.trunc(Number(args.limit)))
        text = lines.slice(offset, offset + limit).join('\n')
      }
      if (original.truncated) {
        text += '\n[truncated: file is larger than ' + String(config.maxFileBytes) + ' bytes]'
      }
      return envelope({ text, truncated: original.truncated })
    },
  }
}

/** `write` - atomic write on the WSL side. */
function writeTool({ pool, config, workspaceFor, where }) {
  return {
    name: 'write',
    description: [
      'Create or overwrite a text file on the WSL side, atomically. Relative paths',
      'resolve against ' + where + '; Windows paths are translated.',
      'Pass `expectedSha256` to refuse the write when the file changed since you',
      'read it. Parent directories are not created automatically.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Linux path to write.' },
        content: { type: 'string', description: 'Full file content (UTF-8).' },
        expectedSha256: { type: 'string', description: 'Refuse unless the current file has this sha256.' },
      },
      required: ['path', 'content'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const active = await workspaceFor(args.path)
      const path = resolveWorldPath(args.path, exec, active)
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

/** `edit` - string replacement fenced by sha256. */
function editTool({ pool, config, workspaceFor }) {
  return {
    name: 'edit',
    description: [
      'Replace a string in a file on the WSL side. `oldString` must be unique',
      'unless `replaceAll` is true. A best-effort sha256 check detects stale content',
      'before rename; avoid concurrent external writes (no atomic compare-and-swap).',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Linux path to edit.' },
        oldString: { type: 'string', description: 'Exact text to replace (must occur once unless replaceAll).' },
        newString: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const active = await workspaceFor(args.path)
      const path = resolveWorldPath(args.path, exec, active)
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
          + (edited.replacements === 1 ? '' : 's') + ')',
      })
    },
  }
}

/** `grep` - search file contents inside the distribution. */
function grepTool({ pool, config, workspaceFor, where }) {
  return {
    name: 'grep',
    description: [
      'Search file contents inside the WSL distribution with GNU grep -E, returning',
      '`path:line: text` rows. `path` defaults to ' + where + '. Skips',
      'hidden entries, node_modules and VCS metadata; `.gitignore` is not read.',
      '`include` filters file names like `*.ts`.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'POSIX extended regular expression.' },
        path: { type: 'string', description: 'Linux path to search (default: session directory).' },
        include: { type: 'string', description: 'Only search files whose name matches this glob, e.g. *.ts.' },
      },
      required: ['pattern'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const active = await workspaceFor(args.path)
      const root = typeof args.path === 'string' && args.path !== ''
        ? resolveWorldPath(args.path, exec, active)
        : defaultRoot(exec, active)
      const include = typeof args.include === 'string' ? args.include : ''
      const result = await grepFiles(pool, {
        pattern: String(args.pattern), root, include, maxMatches: 250, timeoutMs: config.fileTimeoutMs,
      })
      return envelope({
        text: renderGrep(result, root, 250),
        exitCode: result.error === null ? 0 : 1,
        truncated: result.truncated,
      })
    },
  }
}

/** `glob` - list files inside the distribution. */
function globTool({ pool, config, workspaceFor, where }) {
  return {
    name: 'glob',
    description: [
      'List files inside the WSL distribution matching a glob pattern (`**`, `*`,',
      '`?`, `[...]`, `{a,b}`). Results are relative to `path` (default: ' + where + ')',
      'and sorted oldest-first. Hidden entries and node_modules are skipped.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts or src/*.js.' },
        path: { type: 'string', description: 'Linux directory to search (default: session directory).' },
      },
      required: ['pattern'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const active = await workspaceFor(args.path)
      const root = typeof args.path === 'string' && args.path !== ''
        ? resolveWorldPath(args.path, exec, active)
        : defaultRoot(exec, active)
      const result = await globFiles(pool, {
        pattern: String(args.pattern), root, maxResults: 100, timeoutMs: config.fileTimeoutMs,
      })
      return envelope({
        text: renderGlob(result, root, String(args.pattern), 100),
        truncated: result.truncated,
      })
    },
  }
}

/** `wsl_env` - distribution facts (kept for diagnostics in a WSL session). */
function envTool({ pool, config }) {
  return {
    name: 'wsl_env',
    description: 'Report the WSL distribution this session runs in (distro, kernel, user, toolchain).',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
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
        'echo "python3=$(python3 -V 2>/dev/null || echo missing)"',
        'echo "git=$(git --version 2>/dev/null || echo missing)"',
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
 * Default search root: the configured workspace (session directory or `$HOME`).
 * @param {object|undefined} exec
 * @param {object} config
 * @returns {string}
 */
function defaultRoot(exec, config) {
  const workdir = toLinuxWorkdir(undefined, exec, config)
  if (workdir === undefined || workdir === '') {
    throw new Error('this session has no file working directory; pass an absolute Linux path')
  }
  return workdir
}
