/**
 * List one directory inside the current WSL distribution.
 * The path is passed as base64 so a name cannot change the command.
 *
 * @module dsh-wsl-bridge/dir-list
 */
import { isWindowsPath } from './paths.js'

const MAX_ENTRIES = 400

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isListedLinuxPath(value) {
  return typeof value === 'string'
    && value.startsWith('/')
    && !value.includes('\0')
    && !/[\r\n]/u.test(value)
}

/**
 * @param {string} [linuxPath] absolute Linux directory, or empty to start at `$HOME`
 * @returns {string}
 */
export function directoryListCommand(linuxPath) {
  const assignment = linuxPath === undefined || linuxPath === null || linuxPath === ''
    ? 'dir=$HOME'
    : 'dir=$(printf %s ' + quoteBase64(linuxPath) + ' | base64 -d)'
  return [
    assignment,
    'case $dir in /*) ;; *) exit 2 ;; esac',
    'dir=${dir%/}',
    '[ -n "$dir" ] || dir=/',
    '[ -d "$dir" ] || exit 3',
    'win=$(wslpath -w "$dir") || exit 4',
    "printf '\\n__WSL_CWD__%s\\n' \"$(printf %s \"$dir\" | base64 | tr -d '\\n')\"",
    "printf '__WSL_CWDWIN__%s\\n' \"$(printf %s \"$win\" | base64 | tr -d '\\n')\"",
    'parent=$(dirname -- "$dir")',
    'if [ "$parent" != "$dir" ]; then',
    '  pwin=$(wslpath -w "$parent") || exit 4',
    "  printf '__WSL_PARENT__%s\\n' \"$(printf %s \"$parent\" | base64 | tr -d '\\n')\"",
    "  printf '__WSL_PARENTWIN__%s\\n' \"$(printf %s \"$pwin\" | base64 | tr -d '\\n')\"",
    'fi',
    'find "$dir" -mindepth 1 -maxdepth 1 -type d -printf \'%f\\n\' 2>/dev/null | sort | while IFS= read -r name; do',
    '  [ -n "$name" ] || continue',
    "  printf '__WSL_NAME__%s\\n' \"$(printf %s \"$name\" | base64 | tr -d '\\n')\"",
    'done',
  ].join('\n')
}

/**
 * @param {string} stdout
 * @returns {{path: string, windows: string, parent: {path: string, windows: string}|null, entries: {name: string, path: string, windows: string}[]}|null}
 */
export function parseDirectoryListing(stdout) {
  const path = decodeMarker(stdout, 'WSL_CWD')
  const windows = normalizeWindows(decodeMarker(stdout, 'WSL_CWDWIN'))
  if (!path.startsWith('/') || !isWindowsPath(windows)) return null
  const parentPath = decodeMarker(stdout, 'WSL_PARENT')
  const parentWindows = normalizeWindows(decodeMarker(stdout, 'WSL_PARENTWIN'))
  const parent = parentPath.startsWith('/') && isWindowsPath(parentWindows)
    ? { path: parentPath, windows: parentWindows }
    : null
  /** @type {{name: string, path: string, windows: string}[]} */
  const entries = []
  const linuxRoot = path.replace(/\/+$/u, '') || '/'
  const windowsRoot = windows.replace(/\\+$/u, '')
  for (const match of String(stdout ?? '').matchAll(/__WSL_NAME__([^\r\n]*)/gu)) {
    if (entries.length >= MAX_ENTRIES) break
    const name = decodeBase64(match[1].trim())
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) continue
    const childPath = (linuxRoot === '/' ? '' : linuxRoot) + '/' + name
    const windowsPath = windowsRoot + '\\' + name
    if (!isWindowsPath(windowsPath)) continue
    entries.push({ name, path: childPath, windows: windowsPath })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return { path, windows, parent, entries }
}

/**
 * @param {string} linuxPath
 * @returns {string}
 */
function quoteBase64(linuxPath) {
  if (!isListedLinuxPath(linuxPath)) throw new Error('path rejected')
  const encoded = Buffer.from(linuxPath, 'utf8').toString('base64')
  if (!/^[A-Za-z0-9+/=]+$/u.test(encoded)) throw new Error('path rejected')
  return "'" + encoded + "'"
}

/**
 * @param {string} stdout
 * @param {string} name
 * @returns {string}
 */
function decodeMarker(stdout, name) {
  const matches = [...String(stdout ?? '').matchAll(new RegExp('__' + name + '__([^\\r\\n]*)', 'gu'))]
  if (matches.length === 0) return ''
  return decodeBase64(matches[matches.length - 1][1].trim())
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeBase64(value) {
  if (value === '' || !/^[A-Za-z0-9+/=]+$/u.test(value)) return ''
  const text = Buffer.from(value, 'base64').toString('utf8')
  return text.includes('\0') ? '' : text
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeWindows(value) {
  return String(value ?? '').replace(/\//gu, '\\')
}
