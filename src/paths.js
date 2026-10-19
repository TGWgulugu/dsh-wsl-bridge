/**
 * Path translation between the Windows host and the WSL Linux side.
 *
 * Pure functions: the only place that knows the `/mnt/<drive>` convention and
 * the `\\\\wsl.localhost\\<distro>\\...` UNC shape. The `wsl_path` tool prefers
 * the distribution's own `wslpath`; these functions are its fallback and are
 * also what `defaultWorkdir: 'session'` uses to turn the session's Windows cwd
 * into the matching Linux directory.
 *
 * @module dsh-wsl-bridge/paths
 */

/**
 * Whether a value looks like a Windows path (drive letter or UNC).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isWindowsPath(value) {
  return typeof value === 'string'
    && (/^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value))
}

/**
 * Translate a Windows path to the Linux path WSL mounts it at.
 *
 * @param {string} value - `C:\\Users\\me\\a.txt` or `\\\\wsl.localhost\\Ubuntu\\home\\me`.
 * @returns {string|null} the Linux path, or null when the shape is unknown.
 */
export function windowsPathToLinux(value) {
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(value)
  if (drive !== null) {
    return '/mnt/' + drive[1].toLowerCase() + '/' + drive[2].replace(/\\/gu, '/')
  }
  const unc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/u.exec(value)
  if (unc !== null) {
    return '/' + unc[2].replace(/\\/gu, '/')
  }
  return null
}

/**
 * Translate a Linux path to its Windows-visible form.
 *
 * @param {string} value - absolute Linux path.
 * @param {string} distro - distribution name for the UNC form (may be empty).
 * @returns {string|null} the Windows path, or null when no distro is known and
 *   the path is not under `/mnt/<drive>`.
 */
export function linuxPathToWindows(value, distro) {
  const drive = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/u.exec(value)
  if (drive !== null) {
    return drive[1].toUpperCase() + ':\\' + (drive[2] ?? '').replace(/\//gu, '\\')
  }
  if (typeof distro !== 'string' || distro === '') return null
  return '\\\\wsl.localhost\\' + distro + '\\' + value.replace(/^\/+/u, '').replace(/\//gu, '\\')
}

/**
 * The session's working directory as recorded by the host agent, if any.
 * @param {object|undefined} exec - the tool execution facts.
 * @returns {string|null}
 */
export function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * Resolve the Linux working directory for a call.
 *
 * Precedence: explicit argument (Windows path translated, Linux path used as
 * given) > `config.defaultWorkdir` (`home` / absolute path) > the session cwd
 * translated to `/mnt/<drive>`.
 *
 * @param {string|undefined} value - the call's `workdir` argument.
 * @param {object|undefined} exec - the tool execution facts.
 * @param {{defaultWorkdir: string}} config - resolved bridge config.
 * @returns {string|undefined} a Linux working directory, or undefined to leave
 *   the shell in its login directory.
 */
export function toLinuxWorkdir(value, exec, config) {
  if (typeof value === 'string' && value !== '') {
    if (isWindowsPath(value)) {
      const translated = windowsPathToLinux(value)
      if (translated === null) throw new Error('cannot translate Windows path "' + value + '" into a Linux path')
      return translated
    }
    return value
  }
  if (config.defaultWorkdir === 'home') return undefined
  if (config.defaultWorkdir !== '' && config.defaultWorkdir !== 'session') {
    return config.defaultWorkdir
  }
  const cwd = sessionCwd(exec)
  if (cwd === null) return undefined
  if (!isWindowsPath(cwd)) return cwd
  return windowsPathToLinux(cwd) ?? undefined
}

/**
 * Validate that a value is an absolute Linux path, translating a Windows path
 * when the caller passed one by mistake.
 *
 * @param {unknown} value - the call's `path` argument.
 * @returns {string}
 */
export function ensureLinuxPath(value) {
  if (typeof value !== 'string' || value === '') {
    throw new Error('path must be a non-empty string')
  }
  if (isWindowsPath(value)) {
    const translated = windowsPathToLinux(value)
    if (translated === null) throw new Error('cannot translate Windows path "' + value + '" into a Linux path')
    return translated
  }
  if (!value.startsWith('/')) {
    throw new Error('expected an absolute Linux path (starts with /), got "' + value + '"')
  }
  if (value.includes('\0')) throw new Error('path must not contain NUL')
  return value
}
