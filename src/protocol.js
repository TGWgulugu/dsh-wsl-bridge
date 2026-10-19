/**
 * Wire protocol for the session's persistent WSL bash shell.
 *
 * The shell is one long-lived `wsl.exe ... -e bash -l -s` process per agent, so
 * every tool call must (a) inject its command without racing the previous one
 * and (b) find the exact end of that command's output and its exit status inside
 * one continuous byte stream. Both jobs ride this module and nothing else, so
 * the framing is unit-testable without a process.
 *
 * Frame shape, written on stdin for each call:
 *
 *     command printf '\n%s\n' '<M>BEGIN'
 *     . /dev/stdin <<'<M>END'
 *     <the model's command, verbatim, any number of lines>
 *     <M>END
 *     __dsh_wsl_bridge_status=$?
 *     command printf '\n%s%d\n' '<M>END' "$__dsh_wsl_bridge_status"
 *
 * Why a heredoc and not a plain brace group: the shell parses a brace group one
 * command at a time, so a syntactic error inside it aborts the REST of the
 * group — an unterminated quote would swallow the end marker and leave the call
 * (and the shell) wedged. The command is therefore read through a heredoc into
 * the source builtin (`.`), which the shell parses as ONE unit: a syntax error
 * is reported and the shell moves on to the next line, where the status capture
 * and the end marker still run.
 *
 * The begin/end markers carry a per-call random nonce, so a command cannot
 * forge the end of its own frame even if it echoes marker-shaped text: the
 * parser accepts only the end marker carrying the nonce it saw in the begin
 * marker.
 *
 * stdout and stderr are separate OS streams, so the parser keeps two buffers:
 * `feed(chunk, 'stdout')` (the default) and `feed(chunk, 'stderr')`. The stderr
 * bytes travel through the WSL subprocess's own stderr channel and are never
 * mixed into the command's stdout result.
 *
 * @module dsh-wsl-bridge/protocol
 */
import { randomBytes } from 'node:crypto'

/** Literal prefix of every frame marker; the tag and nonce follow it. */
export const MARKER_PREFIX = '__DSH_WSL_BRIDGE_'

/** Tag of the marker printed before the command runs. */
export const BEGIN_TAG = 'BEGIN_'

/** Tag of the marker printed after the command's status is captured. */
export const END_TAG = 'END_'

/** Suffix closing the nonce, keeping the marker a single shell word. */
export const MARKER_SUFFIX = '__'

/** Name of the shell variable carrying the command's exit status. */
export const STATUS_VAR = '__dsh_wsl_bridge_status'

/** Default ceiling on the stdout bytes buffered while looking for a frame end. */
export const DEFAULT_WATCH_BYTES = 4 * 1024 * 1024

const BEGIN_PREFIX = MARKER_PREFIX + BEGIN_TAG
const END_PREFIX = MARKER_PREFIX + END_TAG
const NONCE_RE = /^[0-9a-zA-Z]+$/u

/**
 * Generate a fresh frame nonce.
 *
 * Random bytes (not a counter or a timestamp) on purpose: a command runs inside
 * the very shell that would echo the marker, so the only thing that makes the
 * end marker unforgeable is that the command cannot know it before it runs.
 *
 * @returns {string} 32 lowercase hex characters.
 */
export function makeNonce() {
  return randomBytes(16).toString('hex')
}

/**
 * Render the stdin frame for one command.
 *
 * The command is inserted verbatim: the heredoc is quoted, so the shell
 * performs no expansion while reading, and the sourced text is executed exactly
 * as the model wrote it.
 *
 * @param {string} command - the command, any number of lines.
 * @returns {{payload: string, nonce: string}} the text to write to the shell's
 *   stdin (newline-terminated) and the nonce its markers carry.
 */
export function buildFrame(command) {
  const nonce = makeNonce()
  const begin = BEGIN_PREFIX + nonce + MARKER_SUFFIX
  const end = END_PREFIX + nonce + MARKER_SUFFIX
  const payload = [
    "command printf '\\n%s\\n' '" + begin + "'",
    ". /dev/stdin <<'" + end + "'",
    command === undefined || command === null ? '' : String(command),
    end,
    STATUS_VAR + '=$?',
    "command printf '\\n%s%d\\n' '" + end + "' \"$" + STATUS_VAR + '"',
    '',
  ].join('\n')
  return { payload, nonce }
}

/**
 * Create the incremental parser for ONE call's output.
 *
 * The parser is fed the raw stream bytes as they arrive (from an offset-based
 * collected reader), so it must tolerate a marker, a status digit or a UTF-8
 * sequence being split across chunks: it re-scans its own buffer on every feed.
 *
 * @param {{watchBytes?: number, stderrWatchBytes?: number}} [options]
 *   `watchBytes` caps the stdout buffer kept while a frame is incomplete;
 *   `stderrWatchBytes` caps the stderr capture (defaults to `watchBytes`).
 * @returns {{
 *   feed: (chunk: string, stream?: 'stdout'|'stderr') =>
 *     {matched: boolean, stdout?: string, stderr?: string, exitCode?: number, rest?: string},
 *   reset: () => void,
 *   partial: () => {stdout: string, stderr: string, lostHead: boolean},
 *   matched: () => boolean,
 * }}
 */
export function createFrameParser(options = {}) {
  const watchBytes = positiveInt(options.watchBytes, DEFAULT_WATCH_BYTES)
  const stderrWatchBytes = positiveInt(options.stderrWatchBytes, watchBytes)

  /** Raw stdout accumulated for the frame being parsed. */
  let stdout = ''
  /** Raw stderr accumulated for the same call. */
  let stderr = ''
  /** True once the completed frame was returned; reset() re-arms. */
  let done = false
  let lostHead = false
  let stderrLostHead = false

  /** Re-arm the parser for the next call. */
  function reset() {
    stdout = ''
    stderr = ''
    done = false
    lostHead = false
    stderrLostHead = false
  }

  /**
   * Feed one chunk of stream bytes.
   * @param {string} chunk
   * @param {'stdout'|'stderr'} [stream]
   * @returns {{matched: boolean, stdout?: string, stderr?: string, exitCode?: number, rest?: string}}
   */
  function feed(chunk, stream = 'stdout') {
    const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
    if (text === '') return { matched: false }
    if (stream === 'stderr') {
      stderr += text
      if (stderr.length > stderrWatchBytes) {
        stderr = stderr.slice(stderr.length - Math.floor(stderrWatchBytes / 2))
        stderrLostHead = true
      }
      return { matched: false }
    }
    if (done) {
      // A completed parser is not re-armed implicitly: a caller either reset()s
      // it or creates a new one. Keeping the stale bytes would let a previous
      // frame leak into the next call's result.
      return { matched: true, ...lastResult(), rest: text }
    }
    stdout += text
    const parsed = tryParse(stdout)
    if (parsed === undefined) {
      trimStdout()
      return { matched: false }
    }
    done = true
    const result = {
      matched: true,
      stdout: parsed.stdout,
      stderr,
      exitCode: parsed.exitCode,
      rest: parsed.rest,
    }
    return result
  }

  /** The result of the last completed frame; used only on a stale feed. */
  let last = undefined
  function lastResult() {
    return last === undefined ? {} : { ...last }
  }

  /**
   * Whatever partial output is recoverable, for timeouts and shell deaths.
   * @returns {{stdout: string, stderr: string, lostHead: boolean}}
   */
  function partial() {
    if (done && last !== undefined) {
      return { stdout: last.stdout, stderr: last.stderr, lostHead }
    }
    const beginAt = stdout.indexOf(BEGIN_PREFIX)
    let body = ''
    if (beginAt >= 0) {
      const nonceStart = beginAt + BEGIN_PREFIX.length
      const nonceEnd = stdout.indexOf(MARKER_SUFFIX, nonceStart)
      if (nonceEnd >= 0 && NONCE_RE.test(stdout.slice(nonceStart, nonceEnd))) {
        body = stdout.slice(nonceEnd + MARKER_SUFFIX.length)
        if (body.startsWith('\n')) body = body.slice(1)
      }
    }
    // Strip a trailing partial end marker (the rest of it never arrived).
    const endAt = body.lastIndexOf(END_PREFIX)
    if (endAt >= 0) {
      const tail = body.slice(endAt)
      if (!tail.includes(MARKER_SUFFIX)) body = body.slice(0, endAt)
    }
    return { stdout: body, stderr, lostHead }
  }

  /**
   * Attempt to recover one complete frame from the accumulated stdout.
   * @param {string} text
   * @returns {{stdout: string, exitCode: number, rest: string}|undefined}
   */
  function tryParse(text) {
    const beginAt = text.indexOf(BEGIN_PREFIX)
    if (beginAt < 0) return undefined
    const nonceStart = beginAt + BEGIN_PREFIX.length
    const nonceEnd = text.indexOf(MARKER_SUFFIX, nonceStart)
    if (nonceEnd < 0) return undefined
    const nonce = text.slice(nonceStart, nonceEnd)
    if (!NONCE_RE.test(nonce)) return undefined
    const beginMarker = BEGIN_PREFIX + nonce + MARKER_SUFFIX
    const endMarker = END_PREFIX + nonce + MARKER_SUFFIX
    const bodyStart = beginAt + beginMarker.length
    const endAt = text.indexOf(endMarker, bodyStart)
    if (endAt < 0) return undefined
    // The end printf is '%s%d\n': the status digits follow the marker directly.
    const statusMatch = /^(\d+)\r?\n/u.exec(text.slice(endAt + endMarker.length))
    if (statusMatch === null) return undefined
    let start = bodyStart
    // The begin printf writes a newline after its marker; drop that one so the
    // recovered stdout starts at the command's first byte.
    if (text[start] === '\n') start += 1
    let body = text.slice(start, endAt)
    // The end printf writes a newline BEFORE its marker; drop exactly that one
    // and keep whatever newline the command itself produced.
    if (body.endsWith('\n')) body = body.slice(0, -1)
    const rest = text.slice(endAt + endMarker.length + statusMatch[0].length)
    last = { stdout: body, stderr, exitCode: Number(statusMatch[1]), rest }
    return last
  }

  /** Drop the head of an over-long unframed stdout buffer, keeping the tail. */
  function trimStdout() {
    if (stdout.length <= watchBytes) return
    stdout = stdout.slice(stdout.length - Math.floor(watchBytes / 2))
    lostHead = true
  }

  return {
    feed,
    reset,
    partial,
    matched: () => done,
    /** Whether the retained stdout lost its head to the watch window. */
    lostHead: () => lostHead,
    /** Whether the retained stderr lost its head to the watch window. */
    stderrLostHead: () => stderrLostHead,
  }
}

/**
 * Normalise a positive integer option, falling back when absent or invalid.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
