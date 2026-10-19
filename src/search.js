/**
 * `grep` / `glob` for a WSL world, implemented inside the distribution.
 *
 * The host's own search suite is backed by a packaged Windows ripgrep, so a
 * Linux-path session cannot reuse it. GNU grep / find ship with every normal
 * distribution; the model-facing shape stays close to the host tools:
 *
 *   grep(pattern, path, include) -> `path:line: text` lines, capped
 *   glob(pattern, path)          -> relative paths sorted oldest-first, capped
 *
 * Differences from ripgrep are stated in the tool descriptions rather than
 * hidden: `.gitignore` is not read, and hidden entries are skipped like
 * ripgrep's default.
 *
 * @module dsh-wsl-bridge/search
 */

/** Directories never descended into (VCS metadata, package caches). */
const PRUNE = ['node_modules', '.git', '.hg', '.svn', '.dsh']

/**
 * grep inside the distribution.
 *
 * @param {object} pool - shell pool.
 * @param {{pattern: string, root: string, include?: string, maxMatches?: number, timeoutMs?: number}} request
 * @returns {Promise<{matches: string[], truncated: boolean, error: string|null}>}
 */
export async function grepFiles(pool, { pattern, root, include = '', maxMatches = 250, timeoutMs = 30_000 }) {
  const cap = Math.max(1, Math.trunc(maxMatches))
  const argv = [
    'grep', '-rnIE', '--color=never',
    ...PRUNE.map((dir) => '--exclude-dir=' + shellQuote(dir)),
    ...(include === '' ? [] : ['--include=' + shellQuote(include)]),
    '-e', shellQuote(pattern), shellQuote(root),
  ]
  const command = argv.join(' ') + ' | head -n ' + String(cap + 1)
    + '; st=${PIPESTATUS[0]}; printf "\\n__WSL_GREP_STATUS=%s\\n" "$st"'
  const result = await pool.runOnce({ command, timeoutMs })
  const status = /__WSL_GREP_STATUS=(\d+)/u.exec(result.stdout)
  const body = result.stdout.replace(/\n?__WSL_GREP_STATUS=\d+\n?$/u, '')
  const exit = status === null ? result.exitCode : Number(status[1])
  if (exit === 2) {
    return { matches: [], truncated: false, error: result.stderr.trim() || 'grep failed' }
  }
  const lines = body.split('\n').filter((line) => line !== '')
  const truncated = lines.length > cap
  const kept = lines.slice(0, cap).map((line) => normalizeGrepLine(line, root))
  return { matches: kept, truncated, error: null }
}

/**
 * glob inside the distribution: list files, match here, sort oldest-first.
 *
 * @param {object} pool
 * @param {{pattern: string, root: string, maxResults?: number, timeoutMs?: number}} request
 * @returns {Promise<{files: string[], truncated: boolean}>}
 */
export async function globFiles(pool, { pattern, root, maxResults = 100, timeoutMs = 30_000 }) {
  const cap = Math.max(1, Math.trunc(maxResults))
  const command = 'find ' + shellQuote(root) + ' -type f -printf "%T@ %p\\n" 2>/dev/null | head -n 50000'
  const result = await pool.runOnce({ command, timeoutMs })
  const entries = []
  for (const line of result.stdout.split('\n')) {
    if (line === '') continue
    const gap = line.indexOf(' ')
    if (gap <= 0) continue
    const mtime = Number(line.slice(0, gap))
    const full = line.slice(gap + 1)
    const relative = relativeTo(root, full)
    if (relative === null) continue
    if (isPruned(relative)) continue
    if (!matchGlob(pattern, relative)) continue
    entries.push({ relative, mtime: Number.isFinite(mtime) ? mtime : 0 })
  }
  entries.sort((a, b) => a.mtime - b.mtime || a.relative.localeCompare(b.relative))
  const truncated = entries.length > cap
  return { files: entries.slice(0, cap).map((entry) => entry.relative), truncated }
}

/**
 * Render a grep result the way the model expects.
 *
 * @param {{matches: string[], truncated: boolean, error: string|null}} result
 * @param {string} root
 * @param {number} cap
 * @returns {string}
 */
export function renderGrep(result, root, cap) {
  if (result.error !== null) return 'grep failed: ' + result.error
  if (result.matches.length === 0) return 'No matches in ' + root
  const lines = ['Found ' + String(result.matches.length) + ' matches in ' + root + ':', '']
  lines.push(...result.matches.map((line) => '  ' + line))
  if (result.truncated) lines.push('', '[results truncated at ' + String(cap) + ' matches]')
  return lines.join('\n')
}

/**
 * Render a glob result.
 *
 * @param {{files: string[], truncated: boolean}} result
 * @param {string} root
 * @param {string} pattern
 * @param {number} cap
 * @returns {string}
 */
export function renderGlob(result, root, pattern, cap) {
  if (result.files.length === 0) return 'No files matching ' + pattern + ' in ' + root
  const lines = result.files.map((file) => root.replace(/\/$/u, '') + '/' + file)
  if (result.truncated) lines.push('[results truncated at ' + String(cap) + ' files]')
  return lines.join('\n')
}

/**
 * Normalize one `grep -H` line to `relative/path:line: text`.
 * @param {string} line
 * @param {string} root
 * @returns {string}
 */
function normalizeGrepLine(line, root) {
  const prefix = root.replace(/\/$/u, '') + '/'
  const body = line.startsWith(prefix) ? line.slice(prefix.length) : line
  const first = body.indexOf(':')
  if (first < 0) return body
  const second = body.indexOf(':', first + 1)
  if (second < 0) return body
  return body.slice(0, second) + ':' + body.slice(second + 1)
}

/**
 * Path of `full` relative to `root`, or null when outside it.
 * @param {string} root
 * @param {string} full
 * @returns {string|null}
 */
function relativeTo(root, full) {
  const clean = root.replace(/\/+$/u, '')
  if (full === clean) return ''
  const prefix = clean + '/'
  if (!full.startsWith(prefix)) return null
  return full.slice(prefix.length)
}

/**
 * Whether a relative path contains a pruned directory or hidden component.
 * @param {string} relative
 * @returns {boolean}
 */
function isPruned(relative) {
  const parts = relative.split('/')
  for (const part of parts.slice(0, -1)) {
    if (PRUNE.includes(part)) return true
    if (part.startsWith('.') && part !== '.' && part !== '..') return true
  }
  return false
}

/**
 * Match a relative path against a glob pattern (ripgrep-like subset:
 * `**`, `*`, `?`, `[...]`, `{a,b}`, and a leading `!`).
 *
 * @param {string} pattern
 * @param {string} relative
 * @returns {boolean}
 */
export function matchGlob(pattern, relative) {
  let negated = false
  let source = pattern.replace(/\\/gu, '/')
  if (source.startsWith('!')) {
    negated = true
    source = source.slice(1)
  }
  const basenameOnly = !source.includes('/')
  const candidate = basenameOnly ? relative.slice(relative.lastIndexOf('/') + 1) : relative
  const matched = globToRegExp(source, basenameOnly).test(candidate)
  return negated ? !matched : matched
}

/**
 * Compile a glob fragment to a RegExp.
 * @param {string} glob
 * @param {boolean} basenameOnly
 * @returns {RegExp}
 */
function globToRegExp(glob, basenameOnly) {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += basenameOnly ? '' : '(?:[^/]+/)*'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (char === '[') {
      const close = glob.indexOf(']', i + 1)
      if (close > i + 1) {
        out += '[' + glob.slice(i + 1, close).replace(/^!/u, '^') + ']'
        i = close + 1
        continue
      }
      out += '\\['
      i += 1
      continue
    }
    if (char === '{') {
      const close = glob.indexOf('}', i + 1)
      if (close > i + 1) {
        const alternatives = glob.slice(i + 1, close).split(',')
        out += '(?:' + alternatives.map((alt) => escapeRegExp(alt)).join('|') + ')'
        i = close + 1
        continue
      }
      out += '\\{'
      i += 1
      continue
    }
    out += escapeRegExp(char)
    i += 1
  }
  return new RegExp('^' + out + '$', 'u')
}

/** @param {string} value @returns {string} */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Single-quote a value for bash.
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/gu, "'\\''") + "'"
}
