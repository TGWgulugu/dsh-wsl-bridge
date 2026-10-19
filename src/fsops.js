/**
 * File operations on the WSL side, implemented over the one-shot shell runner.
 *
 * Why not `ctx.fs`: the fs seam on DSH 0.2.1 has no cross-world provider route
 * that works from a Windows host into a distribution without replacing the
 * global `fs` service, and the search tools are backed by a Windows ripgrep.
 * Running `cat`/`base64`/`sha256sum` inside the distribution is the smallest
 * honest implementation; it also keeps the file policy story explicit: these
 * calls are WSL operations, not host filesystem operations.
 *
 * Payloads travel as base64 so quotes, newlines and non-UTF-8 bytes in the
 * command line can never change the meaning of a path or of file content.
 *
 * @module dsh-wsl-bridge/fsops
 */

import { createHash } from 'node:crypto'

/**
 * Quote a value for bash (single quotes, embedded quotes escaped).
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/gu, "'\\''") + "'"
}

/**
 * Read a text file from the WSL side.
 *
 * @param {object} pool - shell pool (`runOnce`).
 * @param {{path: string, maxBytes?: number, timeoutMs?: number}} request
 * @returns {Promise<{text: string, truncated: boolean, bytes: number, sha256: string}>}
 */
export async function readText(pool, { path, maxBytes = 2 * 1024 * 1024, timeoutMs = 30_000 }) {
  const cap = Math.max(1_024, maxBytes)
  const result = await pool.runOnce({
    command: 'set -o pipefail; head -c ' + String(cap + 1) + ' -- ' + shellQuote(path) + ' | base64 -w 0',
    timeoutMs,
  })
  if (result.exitCode !== 0) {
    throw new Error('cannot read ' + path + ': ' + (result.stderr.trim() || 'exit code ' + String(result.exitCode)))
  }
  if (result.truncated || result.spillPath) {
    throw new Error('file transport was truncated; use a smaller maxFileBytes or read it inside WSL')
  }
  const raw = Buffer.from(result.stdout.trim(), 'base64')
  const truncated = raw.length > cap
  const bytes = truncated ? raw.subarray(0, cap) : raw
  return { text: bytes.toString('utf8'), truncated, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * Atomically write text to a path on the WSL side.
 *
 * Writes a sibling temp file, then renames it over the target, so a reader never
 * observes a half-written file. When `expectedSha256` is supplied the write is
 * refused if the file changed since it was read (the classic stale-write fence).
 *
 * @param {object} pool
 * @param {{path: string, text: string, expectedSha256?: string, timeoutMs?: number}} request
 * @returns {Promise<{ok: boolean, code?: string, current?: string, bytes: number, sha256: string}>}
 */
export async function writeText(pool, { path, text, expectedSha256 = '', timeoutMs = 30_000 }) {
  const slash = path.lastIndexOf('/')
  const directory = slash <= 0 ? '/' : path.slice(0, slash)
  const command = [
    't=$(mktemp ' + shellQuote(directory + '/.dsh-wsl-bridge.XXXXXX') + ') || exit 1',
    "trap 'rm -f -- \"$t\"' EXIT",
    'set -o pipefail',
    'base64 -d > "$t"',
    'if [ -e ' + shellQuote(path) + ' ]; then chmod --reference=' + shellQuote(path) + ' -- "$t"; fi',
    ...(expectedSha256 === '' ? [] : [
      '{ current=$(sha256sum < ' + shellQuote(path) + ' 2>/dev/null) || current=""; }',
      'current=${current%% *}',
      'if [ "$current" != ' + shellQuote(expectedSha256) + ' ]; then printf "%s\\n" "$current"; exit 73; fi',
    ]),
    'mv -fT -- "$t" ' + shellQuote(path),
    'sha256sum -- ' + shellQuote(path) + " | cut -d' ' -f1",
  ].join(' && ')

  const payload = Buffer.from(text, 'utf8').toString('base64')
  const result = await pool.runOnce({ command, input: payload, timeoutMs })
  if (expectedSha256 !== '' && result.exitCode === 73) {
    const current = result.stdout.trim()
    return { ok: false, code: 'stale', current, bytes: 0, sha256: current }
  }
  if (result.exitCode !== 0) {
    throw new Error('cannot write ' + path + ': ' + (result.stderr.trim() || 'exit code ' + String(result.exitCode)))
  }
  return {
    ok: true,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: result.stdout.trim(),
  }
}

/**
 * Fetch fresh content, apply a string replacement in the host, write it back
 * under a best-effort sha256 fence. Hash the exact bytes read, then recheck just
 * before rename. This is not an atomic compare-and-swap against external writers.
 *
 * @param {object} pool
 * @param {{path: string, oldString: string, newString: string, replaceAll?: boolean,
 *          maxBytes?: number, timeoutMs?: number}} request
 * @returns {Promise<{ok: boolean, code?: string, current?: string, bytes: number,
 *          sha256: string, replacements: number}>}
 */
export async function editText(pool, {
  path, oldString, newString, replaceAll = false, maxBytes = 2 * 1024 * 1024, timeoutMs = 30_000,
}) {
  if (typeof oldString !== 'string' || oldString === '') throw new Error('oldString must not be empty')
  const original = await readText(pool, { path, maxBytes, timeoutMs })
  if (original.truncated) {
    throw new Error('file is larger than the configured maxFileBytes; edit it inside WSL instead')
  }
  const occurrences = original.text.split(oldString).length - 1
  if (occurrences === 0) throw new Error('oldString was not found in ' + path)
  if (occurrences > 1 && !replaceAll) {
    throw new Error('oldString appears ' + String(occurrences) + ' times in ' + path
      + '; pass replaceAll: true or use a unique string')
  }
  const expected = original.sha256
  if (createHash('sha256').update(original.text, 'utf8').digest('hex') !== expected) {
    throw new Error('file is not valid UTF-8; edit it inside WSL instead')
  }
  const updated = replaceAll
    ? original.text.split(oldString).join(newString)
    : original.text.replace(oldString, () => newString)
  const written = await writeText(pool, { path, text: updated, expectedSha256: expected, timeoutMs })
  return { ...written, replacements: replaceAll ? occurrences : 1 }
}
