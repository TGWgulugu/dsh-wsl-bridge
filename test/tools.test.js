/**
 * Unit tests for the zero-dependency half of dsh-wsl-bridge:
 * config validation, path translation, mount wiring and every tool's contract
 * against a fake shell pool. No real WSL process is started here.
 *
 * Run with the host node directly:  node test/tools.test.js
 * (not `node --test test/`: under the DSH sandbox that runner spawns a child
 * with piped stdio and fails with EPERM).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveConfig } from '../src/config.js'
import { apply } from '../index.js'
import { ensureLinuxPath, isWindowsPath, linuxPathToWindows, toLinuxWorkdir, windowsPathToLinux } from '../src/paths.js'
import { buildTools, formatRun } from '../src/tools.js'
import { createFakeContext } from './fake-ctx.js'

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

/** Assert that a function throws with a message matching a fragment. */
function throwsWith(fragment, fn) {
  assert.throws(fn, (error) => String(error.message).includes(fragment))
}

/** A fake shell pool: `run` for the persistent shell, `runOnce` for one-shots. */
function makePool(handlers = {}) {
  const calls = { run: [], runOnce: [] }
  return {
    calls,
    async run(key, request) {
      calls.run.push({ key, request })
      if (handlers.run !== undefined) return handlers.run(key, request)
      return { stdout: 'ok\n', stderr: '', exitCode: 0, timeoutMs: request.timeoutMs, signal: null, timedOut: false, aborted: false }
    },
    async runOnce(request) {
      calls.runOnce.push(request)
      if (handlers.runOnce !== undefined) return handlers.runOnce(request)
      return { stdout: '', stderr: '', exitCode: 0, timeoutMs: request.timeoutMs, signal: null, timedOut: false, aborted: false }
    },
    dispose() {},
    disposeAll() {},
  }
}

/** Build a tool map from a fresh mount. */
function toolMap(pool, config) {
  const tools = buildTools({ pool, config })
  return new Map(tools.map((tool) => [tool.name, tool]))
}

const config = resolveConfig({ timeoutMs: 5_000, fileTimeoutMs: 5_000 })

await test('config: defaults are complete', () => {
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.promptSection, true)
  assert.equal(defaults.promptSectionName, 'tool:wsl-bridge')
  assert.equal(defaults.timeoutMs, 120_000)
})

await test('config: env self-check hook overrides the shipped row pin', () => {
  process.env.DSH_WSL_BRIDGE_SELFCHECK = '1'
  process.env.DSH_WSL_BRIDGE_MARKER = 'D:\\tmp\\marker.log'
  try {
    const pinned = resolveConfig({ selfCheck: false, selfCheckMarker: '' })
    assert.equal(pinned.selfCheck, true)
    assert.equal(pinned.selfCheckMarker, 'D:\\tmp\\marker.log')
  } finally {
    delete process.env.DSH_WSL_BRIDGE_SELFCHECK
    delete process.env.DSH_WSL_BRIDGE_MARKER
  }
})

await test('config: rejects a bad timeout', () => {
  throwsWith('config.timeoutMs', () => resolveConfig({ timeoutMs: 10 }))
})

await test('paths: windows drive <-> /mnt', () => {
  assert.equal(windowsPathToLinux('C:\\Users\\me\\a.txt'), '/mnt/c/Users/me/a.txt')
  assert.equal(linuxPathToWindows('/mnt/d/proj/x', 'Ubuntu'), 'D:\\proj\\x')
})

await test('paths: wsl UNC <-> linux', () => {
  assert.equal(windowsPathToLinux('\\\\wsl.localhost\\Ubuntu\\home\\me'), '/home/me')
  assert.equal(linuxPathToWindows('/home/me', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\me')
})

await test('paths: session workdir translates to /mnt', () => {
  const exec = { agent: { session: { header: { cwd: 'D:\\proj\\app' } } } }
  assert.equal(toLinuxWorkdir(undefined, exec, config), '/mnt/d/proj/app')
  assert.equal(toLinuxWorkdir('/home/x', exec, config), '/home/x')
  assert.equal(toLinuxWorkdir(undefined, exec, { ...config, defaultWorkdir: 'home' }), undefined)
})

await test('paths: rejects relative and NUL paths', () => {
  throwsWith('absolute Linux path', () => ensureLinuxPath('relative/path'))
  throwsWith('NUL', () => ensureLinuxPath('/tmp/a\u0000b'))
})

await test('mount: registers six tools and one prompt section', () => {
  const fake = createFakeContext()
  const pool = makePool()
  // apply() builds its own pool from ctx.subprocess; stub spawn so it never runs.
  fake.ctx.subprocess.spawn = () => {
    throw new Error('unexpected spawn during mount')
  }
  apply(fake.ctx, { timeoutMs: 5_000 })
  assert.deepEqual([...fake.tools.keys()].sort(), [
    'wsl_bash', 'wsl_edit', 'wsl_env', 'wsl_path', 'wsl_read', 'wsl_write',
  ])
  assert.equal(fake.sections.size, 1)
  assert.equal(fake.sections.get('tool:wsl-bridge').interpolate, false)
  assert.ok(fake.log.some((line) => line.includes('mounted')))
  fake.dispose()
  assert.equal(fake.tools.size, 0)
  assert.equal(fake.sections.size, 1, 'prompt section cleanup is owned by the service, not this test')
})

await test('wsl_bash: runs in the session workdir and renders [exit code]', async () => {
  const pool = makePool({
    run: (_key, request) => ({
      stdout: 'hello\n', stderr: '', exitCode: 0, timeoutMs: request.timeoutMs,
      signal: null, timedOut: false, aborted: false,
    }),
  })
  const tools = toolMap(pool, config)
  const exec = { agent: { session: { header: { cwd: 'C:\\proj' } } }, signal: undefined }
  const value = await tools.get('wsl_bash').execute({ command: 'echo hello', description: 'say hi' }, exec)
  assert.match(value.text, /hello/)
  assert.match(value.text, /\[exit code: 0\]/)
  assert.equal(pool.calls.run[0].request.workdir, '/mnt/c/proj')
})

await test('wsl_bash: timeout marker uses the armed deadline', () => {
  const text = formatRun({ stdout: '', stderr: '', exitCode: 124, timedOut: true, timeoutMs: 1_500 }, 1_500)
  assert.match(text, /timed out after 1500ms/)
})

await test('wsl_read: decodes base64 and slices lines', async () => {
  const content = 'line1\nline2\nline3\n'
  const pool = makePool({
    runOnce: () => ({ stdout: Buffer.from(content).toString('base64'), stderr: '', exitCode: 0 }),
  })
  const tools = toolMap(pool, config)
  const value = await tools.get('wsl_read').execute({ path: '/home/me/a.txt', offset: 1, limit: 1 }, {})
  assert.equal(value.text, 'line2')
})

await test('wsl_write: sends base64 on stdin and reports sha256', async () => {
  const pool = makePool({
    runOnce: (request) => ({ stdout: 'abc123\n', stderr: '', exitCode: 0, command: request.command }),
  })
  const tools = toolMap(pool, config)
  const value = await tools.get('wsl_write').execute({ path: '/home/me/new.txt', content: 'hi\nthere' }, {})
  assert.match(value.text, /Wrote 8 bytes/)
  assert.match(value.text, /abc123/)
  assert.equal(pool.calls.runOnce[0].input, Buffer.from('hi\nthere').toString('base64'))
})

await test('wsl_write: stale fence refuses the write', async () => {
  const pool = makePool({
    runOnce: (request) => {
      return { stdout: 'different\n', stderr: '', exitCode: 73 }
    },
  })
  const tools = toolMap(pool, config)
  const value = await tools.get('wsl_write').execute({
    path: '/home/me/a.txt', content: 'x', expectedSha256: 'expected',
  }, {})
  assert.equal(value.exitCode, 1)
  assert.match(value.text, /\[stale\]/)
})

await test('wsl_edit: unique replacement writes the edited content', async () => {
  const original = 'alpha beta\n'
  const pool = makePool({
    runOnce: (request) => {
      if (request.command.includes('head -c')) {
        return { stdout: Buffer.from(original).toString('base64'), stderr: '', exitCode: 0 }
      }
      assert.ok(request.command.includes(createHash('sha256').update(original).digest('hex')))
      return { stdout: 'new-sha\n', stderr: '', exitCode: 0 }
    },
  })
  const tools = toolMap(pool, config)
  const value = await tools.get('wsl_edit').execute({
    path: '/home/me/a.txt', oldString: 'beta', newString: 'gamma',
  }, {})
  assert.match(value.text, /1 replacement/)
  const write = pool.calls.runOnce.find((request) => request.command.startsWith('t=$(mktemp'))
  assert.equal(Buffer.from(write.input, 'base64').toString('utf8'), 'alpha gamma\n')
})

await test('wsl_edit: ambiguous match is refused', async () => {
  const pool = makePool({
    runOnce: () => ({ stdout: Buffer.from('x x\n').toString('base64'), stderr: '', exitCode: 0 }),
  })
  const tools = toolMap(pool, config)
  await assert.rejects(
    () => tools.get('wsl_edit').execute({ path: '/a', oldString: 'x', newString: 'y' }, {}),
    /appears 2 times/,
  )
})

await test('wsl_path: falls back to the pure mapping when wslpath is unavailable', async () => {
  const pool = makePool({
    runOnce: () => ({ stdout: '', stderr: 'wsl.exe missing', exitCode: 1 }),
  })
  const tools = toolMap(pool, config)
  const value = await tools.get('wsl_path').execute({ path: 'C:\\Users\\me' }, {})
  assert.match(value.text, /\/mnt\/c\/Users\/me/)
})

await test('wsl_env: renders key=value lines', async () => {
  const pool = makePool({
    runOnce: () => ({
      stdout: 'distro=Ubuntu\nkernel=Linux 6.6\nnode=v22\n', stderr: '', exitCode: 0,
    }),
  })
  const tools = toolMap(pool, config)
  const value = await tools.get('wsl_env').execute({}, {})
  assert.match(value.text, /distro=Ubuntu/)
  assert.match(value.text, /\[exit code: 0\]/)
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) {
  for (const failure of failures) console.error('\n' + failure)
  process.exit(1)
}
