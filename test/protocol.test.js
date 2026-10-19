/**
 * Unit tests for the persistent-shell wire protocol (src/protocol.js).
 *
 * Run with the host node directly:  node test/protocol.test.js
 * (not `node --test test/`: under the DSH sandbox that runner spawns a child
 * with piped stdio and fails with EPERM).
 *
 * No process is started here: the tests feed the parser byte strings shaped
 * exactly like real bash output and assert on the recovered frame.
 */
import assert from 'node:assert/strict'
import {
  BEGIN_TAG,
  END_TAG,
  MARKER_PREFIX,
  MARKER_SUFFIX,
  STATUS_VAR,
  buildFrame,
  createFrameParser,
} from '../src/protocol.js'

let passed = 0
let failed = 0
const failures = []

/** @param {string} name @param {() => Promise<void>|void} fn */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    failures.push(name + ': ' + (error instanceof Error ? error.stack : String(error)))
    console.log('FAIL ' + name)
  }
}

/** The begin marker for one nonce. */
function beginMarker(nonce) {
  return MARKER_PREFIX + BEGIN_TAG + nonce + MARKER_SUFFIX
}

/** The end marker for one nonce. */
function endMarker(nonce) {
  return MARKER_PREFIX + END_TAG + nonce + MARKER_SUFFIX
}

/**
 * The exact byte stream real bash produces for one frame: the begin printf
 * writes "\n<begin>\n", the command writes its stdout, the final printf writes
 * "\n<end><status>\n".
 * @param {string} nonce
 * @param {string} stdout - what the command itself printed.
 * @param {number} exitCode
 * @param {string} [after] - extra bytes after the frame.
 */
function outputFor(nonce, stdout, exitCode, after = '') {
  return '\n' + beginMarker(nonce) + '\n' + stdout + '\n' + endMarker(nonce) + String(exitCode) + '\n' + after
}

/** Feed one whole string to a parser and return the matched result. */
function parseWhole(text) {
  const parser = createFrameParser()
  const result = parser.feed(text)
  assert.equal(result.matched, true, 'expected the frame to complete')
  return { parser, result }
}

await test('buildFrame: nonce-bearing begin/end markers and quoted heredoc', () => {
  const command = 'echo hello\nprintf "no-newline"'
  const { payload, nonce } = buildFrame(command)
  assert.match(nonce, /^[0-9a-f]{32}$/u)
  assert.ok(payload.includes(beginMarker(nonce)), 'begin marker present')
  assert.ok(payload.includes(endMarker(nonce)), 'end marker present')
  assert.ok(
    payload.includes(". /dev/stdin <<'" + endMarker(nonce) + "'"),
    'the command is sourced through a heredoc quoted by the end marker',
  )
  assert.ok(payload.includes(command), 'the command is inserted verbatim')
  assert.ok(payload.includes(STATUS_VAR + '=$?'), 'the exit status is captured with $?')
  assert.ok(payload.endsWith('\n'), 'the payload is newline-terminated')
})

await test('buildFrame: a different nonce every call', () => {
  const first = buildFrame('true')
  const second = buildFrame('true')
  assert.notEqual(first.nonce, second.nonce)
  assert.ok(!first.payload.includes(second.nonce), 'a payload only carries its own nonce')
})

await test('buildFrame: shell syntax in the command is not expanded', () => {
  const command = "echo \"$HOME `date` 'quoted' \\n\"; echo ${UNSET:-x}"
  const { payload } = buildFrame(command)
  assert.ok(payload.includes(command), 'the model command appears byte for byte')
})

await test('parser: complete frame in one chunk', () => {
  const { nonce } = buildFrame('true')
  const { result } = parseWhole(outputFor(nonce, 'hello\n', 0))
  assert.equal(result.stdout, 'hello\n')
  assert.equal(result.stderr, '')
  assert.equal(result.exitCode, 0)
  assert.equal(result.rest, '')
})

await test('parser: output without a trailing newline is preserved exactly', () => {
  const { nonce } = buildFrame('true')
  const { result } = parseWhole(outputFor(nonce, 'no-newline', 0))
  assert.equal(result.stdout, 'no-newline')
})

await test('parser: output is recovered one character at a time', () => {
  const { nonce } = buildFrame('printf hi')
  const bytes = outputFor(nonce, 'hi\nthere\n', 3)
  const parser = createFrameParser()
  let matched = undefined
  for (let index = 0; index < bytes.length; index += 1) {
    matched = parser.feed(bytes[index])
    if (index < bytes.length - 1) assert.equal(matched.matched, false, 'no early match at char ' + String(index))
  }
  assert.equal(matched.matched, true)
  assert.equal(matched.stdout, 'hi\nthere\n')
  assert.equal(matched.exitCode, 3)
})

await test('parser: a marker split across chunks is still found', () => {
  const { nonce } = buildFrame('true')
  const bytes = outputFor(nonce, 'split\n', 0)
  const cut = bytes.indexOf(endMarker(nonce)) + 9
  const parser = createFrameParser()
  assert.equal(parser.feed(bytes.slice(0, cut)).matched, false)
  const matched = parser.feed(bytes.slice(cut))
  assert.equal(matched.matched, true)
  assert.equal(matched.stdout, 'split\n')
})

await test('parser: stderr is kept out of stdout', () => {
  const { nonce } = buildFrame('shout')
  const bytes = outputFor(nonce, 'on stdout\n', 0)
  const parser = createFrameParser()
  parser.feed('warn 1\n', 'stderr')
  const matched = parser.feed(bytes.slice(0, 5))
  parser.feed('warn 2\n', 'stderr')
  const final = parser.feed(bytes.slice(5))
  assert.equal(matched.matched, false)
  assert.equal(final.matched, true)
  assert.equal(final.stdout, 'on stdout\n')
  assert.equal(final.stderr, 'warn 1\nwarn 2\n')
})

await test('parser: a nonzero status is reported', () => {
  const { nonce } = buildFrame('false')
  const { result } = parseWhole(outputFor(nonce, '', 42))
  assert.equal(result.exitCode, 42)
  assert.equal(result.stdout, '')
})

await test('parser: a forged end marker with another nonce is ignored', () => {
  const { nonce } = buildFrame('true')
  const { nonce: other } = buildFrame('true')
  // The command echoes a complete fake frame: begin, end and status digits.
  const forged = '\n' + beginMarker(other) + '\nFALSE\n' + endMarker(other) + '0\n'
  const stdout = 'before\n' + forged + 'after\n'
  const { result } = parseWhole(outputFor(nonce, stdout, 5))
  assert.equal(result.exitCode, 5, 'only the real status is accepted')
  assert.equal(result.stdout, stdout, 'the forged bytes are part of the command output')
})

await test('parser: the nonce alone is not a frame', () => {
  const { nonce } = buildFrame('true')
  const parser = createFrameParser()
  // A bare begin marker plus marker-shaped text, but no matching end digits.
  const result = parser.feed('\n' + beginMarker(nonce) + '\npartial\n')
  assert.equal(result.matched, false)
  const partial = parser.partial()
  assert.equal(partial.stdout, 'partial\n')
})

await test('parser: text after the frame is returned as rest', () => {
  const { nonce } = buildFrame('true')
  const { result } = parseWhole(outputFor(nonce, 'body\n', 0, 'TRAILING'))
  assert.equal(result.stdout, 'body\n')
  assert.equal(result.rest, 'TRAILING')
})

await test('parser: reset re-arms for the next frame', () => {
  const first = buildFrame('echo one')
  const second = buildFrame('echo two')
  const parser = createFrameParser()
  const one = parser.feed(outputFor(first.nonce, 'one\n', 0))
  assert.equal(one.matched, true)
  // A completed parser does not silently treat new bytes as a frame...
  const stale = parser.feed(outputFor(second.nonce, 'two\n', 0))
  assert.equal(stale.matched, true)
  assert.equal(stale.rest.includes(second.nonce), true, 'the new bytes come back as rest')
  // ...until it is explicitly re-armed.
  parser.reset()
  const two = parser.feed(outputFor(second.nonce, 'two\n', 0))
  assert.equal(two.matched, true)
  assert.equal(two.stdout, 'two\n')
})

await test('parser: empty output and status 0', () => {
  const { nonce } = buildFrame('true')
  const { result } = parseWhole(outputFor(nonce, '', 0))
  assert.equal(result.stdout, '')
  assert.equal(result.exitCode, 0)
})

await test('parser: a frame with Unicode output survives', () => {
  const { nonce } = buildFrame('echo 你好')
  const { result } = parseWhole(outputFor(nonce, '你好，世界\n', 0))
  assert.equal(result.stdout, '你好，世界\n')
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) {
  for (const failure of failures) console.error('\n' + failure)
  process.exit(1)
}
