/**
 * Unit tests for the WSL preset tools and the in-distribution grep/glob.
 * Fake pool only; no real WSL process.
 *
 * Run: node test/world-tools.test.js
 */
import assert from 'node:assert/strict'
import { globFiles, grepFiles, matchGlob } from '../src/search.js'
import { buildWorldTools, resolveWorldPath } from '../src/world-tools.js'
import { resolveConfig } from '../src/config.js'
import { apply } from '../wsl-world.js'
import { createFakeContext } from './fake-ctx.js'

let passed = 0
let failed = 0
const failures = []

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

function makePool(handlers = {}) {
  const calls = { run: [], runOnce: [] }
  return {
    calls,
    async run(key, request) {
      calls.run.push({ key, request })
      if (handlers.run !== undefined) return handlers.run(key, request)
      return { stdout: '', stderr: '', exitCode: 0, timeoutMs: request.timeoutMs, signal: null, timedOut: false, aborted: false }
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

function toolMap(pool, config) {
  return new Map(buildWorldTools({ pool, config }).map((tool) => [tool.name, tool]))
}

const config = resolveConfig({ timeoutMs: 5_000, fileTimeoutMs: 5_000 })

await test('world: tool names replace the host shell/fs/search set', () => {
  const names = buildWorldTools({ pool: makePool(), config }).map((tool) => tool.name).sort()
  assert.deepEqual(names, ['bash', 'edit', 'glob', 'grep', 'read', 'write', 'wsl_env'])
})

await test('world: path resolution handles absolute, Windows and relative paths', () => {
  const exec = { agent: { session: { header: { cwd: 'D:\\proj\\app' } } } }
  assert.equal(resolveWorldPath('/home/me/a.ts', exec, config), '/home/me/a.ts')
  assert.equal(resolveWorldPath('C:\\Users\\me\\a.ts', exec, config), '/mnt/c/Users/me/a.ts')
  assert.equal(resolveWorldPath('src/a.ts', exec, config), '/mnt/d/proj/app/src/a.ts')
  assert.throws(() => resolveWorldPath('src/a.ts', {}, { ...config, defaultWorkdir: 'home' }), /relative path/)
})

await test('world bash: uses the session directory and renders the exit marker', async () => {
  const pool = makePool({
    run: (_key, request) => ({
      stdout: 'hello\n', stderr: '', exitCode: 0, timeoutMs: request.timeoutMs, signal: null, timedOut: false, aborted: false,
    }),
  })
  const tools = toolMap(pool, config)
  const value = await tools.get('bash').execute({ command: 'echo hello', description: 'hi' }, {
    agent: { session: { header: { cwd: 'D:\\proj' } } },
  })
  assert.match(value.text, /hello/)
  assert.match(value.text, /\[exit code: 0\]/)
  assert.equal(pool.calls.run[0].request.workdir, '/mnt/d/proj')
})

await test('world grep: normalizes rows and reports the cap', async () => {
  const pool = makePool({
    runOnce: () => ({
      stdout: '/proj/src/a.ts:3: hello\n/proj/src/b.ts:9: world\n\n__WSL_GREP_STATUS=0\n',
      stderr: '',
      exitCode: 0,
    }),
  })
  const tools = toolMap(pool, config)
  const value = await tools.get('grep').execute({ pattern: 'hel', path: '/proj' }, {})
  assert.match(value.text, /src\/a\.ts:3: hello/)
  assert.match(value.text, /src\/b\.ts:9: world/)
  assert.match(pool.calls.runOnce[0].command, /grep -rnIE/u)
})

await test('world grep: exit status 2 is a failure, 1 is "no matches"', async () => {
  const failure = makePool({
    runOnce: () => ({ stdout: '\n__WSL_GREP_STATUS=2\n', stderr: 'grep: bad regex', exitCode: 0 }),
  })
  const value = await toolMap(failure, config).get('grep').execute({ pattern: '(' , path: '/proj' }, {})
  assert.match(value.text, /grep failed/)
  assert.equal(value.exitCode, 1)

  const none = makePool({
    runOnce: () => ({ stdout: '\n__WSL_GREP_STATUS=1\n', stderr: '', exitCode: 0 }),
  })
  const empty = await toolMap(none, config).get('grep').execute({ pattern: 'zzz', path: '/proj' }, {})
  assert.match(empty.text, /No matches/)
  assert.equal(empty.exitCode, 0)
})

await test('world glob: filters, prunes and sorts oldest-first', async () => {
  const pool = makePool({
    runOnce: () => ({
      stdout: '300 /proj/src/b.ts\n100 /proj/src/a.ts\n200 /proj/node_modules/x.ts\n',
      stderr: '', exitCode: 0,
    }),
  })
  const value = await toolMap(pool, config).get('glob').execute({ pattern: '**/*.ts', path: '/proj' }, {})
  assert.equal(value.text, '/proj/src/a.ts\n/proj/src/b.ts')
})

await test('search: glob patterns', () => {
  assert.equal(matchGlob('*.ts', 'src/a.ts'), true)
  assert.equal(matchGlob('*.ts', 'src/a.js'), false)
  assert.equal(matchGlob('**/*.ts', 'src/deep/a.ts'), true)
  assert.equal(matchGlob('src/*.js', 'src/a.js'), true)
  assert.equal(matchGlob('src/*.js', 'src/x/a.js'), false)
  assert.equal(matchGlob('{a,b}.md', 'b.md'), true)
  assert.equal(matchGlob('!*.log', 'a.txt'), true)
  assert.equal(matchGlob('!*.log', 'a.log'), false)
})

await test('search: grep rejects an invalid include shape safely', async () => {
  const pool = makePool({
    runOnce: (request) => ({
      stdout: '\n__WSL_GREP_STATUS=0\n', stderr: '', exitCode: 0, command: request.command,
    }),
  })
  const result = await grepFiles(pool, { pattern: 'x', root: '/proj', include: "*.ts'", maxMatches: 5, timeoutMs: 1_000 })
  assert.equal(result.error, null)
})

await test('world apply: registers the preset tool set and writes the mount marker', async () => {
  const marker = 'D:\\try\\experiment\\plugins\\dsh-wsl-bridge\\test\\.world-marker.log'
  process.env.DSH_WSL_BRIDGE_WORLD_MARKER = marker
  try {
    const fake = createFakeContext()
    fake.ctx.subprocess.spawn = () => {
      throw new Error('unexpected spawn during mount')
    }
    apply(fake.ctx, { timeoutMs: 5_000 })
    assert.deepEqual([...fake.tools.keys()].sort(), ['bash', 'edit', 'glob', 'grep', 'read', 'write', 'wsl_env'])
    const { readFileSync, existsSync, rmSync } = await import('node:fs')
    assert.ok(existsSync(marker))
    assert.match(readFileSync(marker, 'utf8'), /\[wsl-world\] mount/)
    rmSync(marker, { force: true })
    fake.dispose()
    assert.equal(fake.tools.size, 0)
  } finally {
    delete process.env.DSH_WSL_BRIDGE_WORLD_MARKER
  }
})

await test('world apply: a broken config only logs, never throws', () => {
  const fake = createFakeContext()
  apply(fake.ctx, { timeoutMs: 1 })
  assert.equal(fake.tools.size, 0)
  assert.ok(fake.log.some((line) => line.includes('error')))
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) {
  for (const failure of failures) console.error('\n' + failure)
  process.exit(1)
}
