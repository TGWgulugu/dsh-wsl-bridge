/**
 * Resolve this computer's WSL home (`wslpath -w "$HOME"`) and register it.
 * The folder the session actually uses is chosen in the desktop picker.
 *
 * @module dsh-wsl-bridge/session-home
 */
import { isWindowsPath } from './paths.js'

/** One-shot probe. Login noise may precede the markers; the last one wins. */
export const HOME_PROBE_COMMAND = "printf '\\n__WSL_HOME__%s\\n__WSL_WINHOME__%s\\n' \"$HOME\" \"$(wslpath -w \"$HOME\")\""

/**
 * @param {string} stdout
 * @returns {{linux: string, windows: string}|null}
 */
export function parseHomeProbe(stdout) {
  const linux = lastMarker(stdout, 'WSL_HOME')
  const windows = lastMarker(stdout, 'WSL_WINHOME').replace(/\//gu, '\\')
  if (!linux.startsWith('/') || linux.includes('\0') || !isWindowsPath(windows)) return null
  return { linux, windows }
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameWindowsDirectory(left, right) {
  const norm = (value) => String(value ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
  return norm(left) !== '' && norm(left) === norm(right)
}

/**
 * Read `$HOME` through `wslpath -w` once and reuse that Windows path.
 * Nothing here names a distribution or a user.
 *
 * @param {object} pool
 * @param {object} config
 * @returns {() => Promise<string>}
 */
export function createHomeLookup(pool, config) {
  /** @type {Promise<string>|undefined} */
  let pending
  return function homeWindows() {
    pending ??= readHomeWindows(pool, config).catch((error) => {
      pending = undefined
      throw error
    })
    return pending
  }
}

/**
 * Register the probed home as a workspace. An existing registration is reused.
 *
 * @param {object} ctx
 * @param {{pool: object, config: object, homeWindows?: () => Promise<string>}} options
 */
export async function ensureWslHomeWorkspace(ctx, { pool, config, homeWindows }) {
  const registry = readService(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.create !== 'function') return
  const lookup = homeWindows ?? createHomeLookup(pool, config)
  await registry.create(await lookup())
}

/**
 * @param {object} pool
 * @param {object} config
 * @returns {Promise<string>}
 */
async function readHomeWindows(pool, config) {
  const result = await pool.runOnce({
    command: HOME_PROBE_COMMAND,
    timeoutMs: config.fileTimeoutMs,
  })
  const parsed = result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true
    ? parseHomeProbe(result.stdout)
    : null
  if (parsed === null) {
    const detail = String(result?.stderr ?? '').trim()
    throw new Error('could not resolve the WSL home directory' + (detail === '' ? '' : ': ' + detail))
  }
  return parsed.windows
}

/**
 * @param {object} ctx
 * @param {string} name
 * @returns {object|undefined}
 */
function readService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {string} text
 * @param {string} name
 * @returns {string}
 */
function lastMarker(text, name) {
  const matches = [...String(text ?? '').matchAll(new RegExp('__' + name + '__([^\\r\\n]*)', 'gu'))]
  return matches.length === 0 ? '' : matches[matches.length - 1][1].trim()
}
