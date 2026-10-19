/**
 * Unit tests for the WSL shell engine (src/shell.js) against a fake subprocess
 * seam. No WSL process, no child_process, no host needed.
 *
 * Run with the host node directly:  node test/shell.test.js
 * (not `node --test test/`: under the DSH sandbox that runner spawns a child
 * with piped stdio and fails with EPERM).
 */
import assert from 'node:assert/strict'
import {
  ShellUnavailableError,
  TIMEOUT_EXIT_CODE,
  buildOneShotArgv,
  buildShellArgv,
  createShellPool,
  shellQuote,
} from '../src/shell.js'
import { createFakeSubprocess } from './fake-subprocess.js'

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

/** A promise that resolves after a real delay. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Build a pool over a fake seam.
 * @param {object} [fakeOptions]
 * @param {object} [config]
 */
function makePool(fakeOptions = {}, config = {}) {
  const fake = createFakeSubprocess(fakeOptions)
  const pool = createShellPool({
    spawn: (options) => fake.spawn(options),
    config: { pollIntervalMs: 1, timeoutMs: 500, ...config },
    logger: () => {},
  })
  return { fake, pool }
}

await test('argv: persistent shell and one-shot command shapes', () => {
  assert.deepEqual(buildShellArgv(), ['wsl.exe', '-e', 'bash', '-l', '-s'])
  assert.deepEqual(buildShellArgv({ distro: 'Ubuntu' }), ['wsl.exe', '-d', 'Ubuntu', '-e', 'bash', '-l', '-s'])
  assert.deepEqual(buildOneShotArgv({ command: 'pwd' }), ['wsl.exe', '-e', 'bash', '-lc', 'pwd'])
  assert.deepEqual(
    buildOneShotArgv({ distro: 'Ubuntu', workdir: '/home/me', command: 'pwd' }),
    ['wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me', '-e', 'bash', '-lc', 'pwd'],
  )
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
})

await test('pool: rejects a missing spawn function', () => {
  assert.throws(() => createShellPool(), /spawn must be a function/u)
})

await test('run: starts one persistent shell and reuses it', async () => {
  const { fake, pool } = makePool({
    shell: (command) => (command === 'echo hello' ? { stdout: 'hello\n' } : { stdout: 'other\n' }),
  })
  const first = await pool.run('agent-a', { command: 'echo hello', timeoutMs: 100 })
  assert.equal(first.stdout, 'hello\n')
  assert.equal(first.stderr, '')
  assert.equal(first.exitCode, 0)
  assert.equal(first.timedOut, false)
  assert.equal(first.aborted, false)
  assert.equal(first.timeoutMs, 100)
  assert.equal(first.shellRestarted, undefined)
  assert.equal(fake.calls.length, 1)
  const spawnOptions = fake.calls[0]
  assert.deepEqual(spawnOptions.argv, ['wsl.exe', '-e', 'bash', '-l', '-s'])
  assert.equal(spawnOptions.stdio.stdin, 'pipe')
  assert.equal(pool.size, 1)
  assert.equal(pool.has('agent-a'), true)

  const second = await pool.run('agent-a', { command: 'echo other', timeoutMs: 100 })
  assert.equal(second.stdout, 'other\n')
  assert.equal(fake.calls.length, 1, 'the same shell process serves the second call')
  const shell = fake.shellHandles()[0]
  assert.equal(shell.frames.length, 2)
  assert.equal(shell.frames[1].command, 'echo other')
  await pool.disposeAll()
})

await test('run: workdir becomes an explicit cd; an omitted workdir keeps the cwd', async () => {
  const commands = []
  const { pool } = makePool({ shell: (command) => { commands.push(command); return { stdout: '' } } })
  await pool.run('agent-a', { command: 'pwd', workdir: '/mnt/c/proj', timeoutMs: 100 })
  await pool.run('agent-a', { command: 'pwd', timeoutMs: 100 })
  assert.deepEqual(commands, ["cd -- '/mnt/c/proj' && pwd", 'pwd'])
  await pool.disposeAll()
})

await test('run: an empty command still applies the workdir prologue', async () => {
  const commands = []
  const { pool } = makePool({ shell: (command) => { commands.push(command); return { stdout: '' } } })
  await pool.run('agent-a', { command: '', workdir: '/tmp', timeoutMs: 100 })
  assert.deepEqual(commands, ["cd -- '/tmp'"])
  await pool.disposeAll()
})

await test('run: env is exported into the persistent shell before the command', async () => {  const commands = []
  const { pool } = makePool({ shell: (command) => { commands.push(command); return { stdout: '' } } })
  await pool.run('agent-a', { command: 'printenv FOO', env: { FOO: "a'b" }, timeoutMs: 100 })
  assert.deepEqual(commands, ["export FOO='a'\\''b' && printenv FOO"])
  await pool.disposeAll()
})

await test('run: chunked output is reassembled exactly', async () => {
  const { pool } = makePool(
    { chunkSize: 3, chunkDelayMs: 1, shell: () => ({ stdout: 'line1\nline2\n', stderr: 'warn\n' }) },
    { pollIntervalMs: 2 },
  )
  const result = await pool.run('agent-a', { command: 'seq 2', timeoutMs: 2_000 })
  assert.equal(result.stdout, 'line1\nline2\n')
  assert.equal(result.stderr, 'warn\n')
  assert.equal(result.exitCode, 0)
  await pool.disposeAll()
})

await test('run: stderr stays separate from stdout', async () => {
  const { pool } = makePool({ shell: () => ({ stdout: 'out\n', stderr: 'err\n' }) })
  const result = await pool.run('agent-a', { command: 'noisy', timeoutMs: 100 })
  assert.equal(result.stdout, 'out\n')
  assert.equal(result.stderr, 'err\n')
  await pool.disposeAll()
})

await test('run: a nonzero exit is reported and the shell stays alive', async () => {
  const { fake, pool } = makePool({
    shell: (command) => (command === 'false' ? { exitCode: 1 } : { stdout: 'still here\n' }),
  })
  const bad = await pool.run('agent-a', { command: 'false', timeoutMs: 100 })
  assert.equal(bad.exitCode, 1)
  const good = await pool.run('agent-a', { command: 'echo again', timeoutMs: 100 })
  assert.equal(good.stdout, 'still here\n')
  assert.equal(good.exitCode, 0)
  assert.equal(fake.calls.length, 1)
  await pool.disposeAll()
})

await test('run: timeout terminates the shell and reports timedOut', async () => {
  const { fake, pool } = makePool({
    shell: (command) => (command === 'slow' ? { hang: true } : { stdout: 'ok\n' }),
  })
  const result = await pool.run('agent-a', { command: 'slow', timeoutMs: 25 })
  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
  assert.equal(result.exitCode, TIMEOUT_EXIT_CODE)
  assert.equal(result.timeoutMs, 25)
  assert.equal(fake.shellHandles()[0].terminated, true)
  assert.equal(pool.size, 0)
  // The next call starts a fresh shell and says so.
  const next = await pool.run('agent-a', { command: 'fast', timeoutMs: 200 })
  assert.equal(next.stdout, 'ok\n')
  assert.equal(next.shellRestarted, true)
  assert.equal(fake.calls.length, 2)
  await pool.disposeAll()
})

await test('run: timeout keeps the partial output produced before the hang', async () => {
  const { pool } = makePool({ shell: () => ({ stdout: 'partial\n', stderr: 'warn\n', hang: true }) })
  const result = await pool.run('agent-a', { command: 'hang', timeoutMs: 25 })
  assert.equal(result.timedOut, true)
  assert.equal(result.stdout, 'partial\n')
  assert.equal(result.stderr, 'warn\n')
  await pool.disposeAll()
})

await test('run: abort terminates the shell and reports aborted', async () => {
  const { fake, pool } = makePool({ shell: () => ({ hang: true }) })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10)
  try {
    const result = await pool.run('agent-a', {
      command: 'sleep 100',
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    assert.equal(result.aborted, true)
    assert.equal(result.timedOut, false)
    assert.equal(fake.shellHandles()[0].terminated, true)
    assert.equal(pool.size, 0)
  } finally {
    clearTimeout(timer)
  }
})

await test('run: abort before the first call spawns nothing', async () => {
  const { fake, pool } = makePool({ shell: () => ({ stdout: 'never\n' }) })
  const controller = new AbortController()
  controller.abort()
  const result = await pool.run('agent-a', {
    command: 'echo never',
    timeoutMs: 100,
    signal: controller.signal,
  })
  assert.equal(result.aborted, true)
  assert.equal(fake.calls.length, 0)
})

await test('run: a shell that exits mid-command is reported and rebuilt next time', async () => {
  const { fake, pool } = makePool({
    shell: (command) => (command === 'exit 7' ? { shellExit: true, exitCode: 7 } : { stdout: 'alive\n' }),
  })
  const death = await pool.run('agent-a', { command: 'exit 7', timeoutMs: 200 })
  assert.equal(death.exitCode, 7)
  assert.equal(death.shellRestarted, true)
  assert.equal(pool.size, 0)
  const next = await pool.run('agent-a', { command: 'echo alive', timeoutMs: 200 })
  assert.equal(next.stdout, 'alive\n')
  assert.equal(next.shellRestarted, true)
  assert.equal(fake.calls.length, 2)
  await pool.disposeAll()
})

await test('run: two agents run concurrently on separate shells', async () => {
  const { fake, pool } = makePool({
    shell: async (command) => {
      await sleep(15)
      if (command.startsWith('echo ')) return { stdout: command.slice(5) + '\n' }
      return {}
    },
  })
  const [one, two] = await Promise.all([
    pool.run('agent-a', { command: 'echo A', timeoutMs: 500 }),
    pool.run('agent-b', { command: 'echo B', timeoutMs: 500 }),
  ])
  assert.equal(one.stdout, 'A\n')
  assert.equal(two.stdout, 'B\n')
  const shells = fake.shellHandles()
  assert.equal(shells.length, 2)
  assert.deepEqual(shells[0].frames[0].command, 'echo A')
  assert.deepEqual(shells[1].frames[0].command, 'echo B')
  await pool.disposeAll()
})

await test('run: two calls on one agent are serialized, never interleaved', async () => {
  let active = 0
  let maxActive = 0
  const { fake, pool } = makePool({
    shell: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(15)
      active -= 1
      return { stdout: 'done\n' }
    },
  })
  const [first, second] = await Promise.all([
    pool.run('agent-a', { command: 'one', timeoutMs: 500 }),
    pool.run('agent-a', { command: 'two', timeoutMs: 500 }),
  ])
  assert.equal(first.stdout, 'done\n')
  assert.equal(second.stdout, 'done\n')
  assert.equal(maxActive, 1, 'frames must not overlap on one persistent shell')
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.shellHandles()[0].frames.length, 2)
  await pool.disposeAll()
})

await test('run: large output is tail-truncated to the budget', async () => {
  const { pool } = makePool(
    { shell: () => ({ stdout: 'A'.repeat(20) + '\n' }) },
    { maxStdoutBytes: 8 },
  )
  const result = await pool.run('agent-a', { command: 'long', timeoutMs: 100 })
  assert.equal(result.stdout, 'AAAAAAA\n')
  await pool.disposeAll()
})

await test('run: a collected spill path is surfaced on the result', async () => {
  const fake = createFakeSubprocess({ shell: () => ({ stdout: 'spilled\n' }) })
  const pool = createShellPool({
    spawn: (options) => {
      const handle = fake.spawn(options)
      const readFrom = handle.collected.stdout.readFrom
      handle.collected.stdout.readFrom = (offset) => ({
        ...readFrom(offset),
        lossy: true,
        spillPath: '/tmp/wsl-bridge-spill.out',
      })
      return handle
    },
    config: { pollIntervalMs: 1, timeoutMs: 500 },
    logger: () => {},
  })
  const result = await pool.run('agent-a', { command: 'noisy', timeoutMs: 100 })
  assert.equal(result.spillPath, '/tmp/wsl-bridge-spill.out')
  await pool.disposeAll()
})

await test('run: a throwing logger never breaks a call', async () => {
  const fake = createFakeSubprocess({ shell: () => ({ stdout: 'ok\n' }) })
  const pool = createShellPool({
    spawn: (options) => fake.spawn(options),
    config: { pollIntervalMs: 1, timeoutMs: 500 },
    logger: { info() { throw new Error('logger boom') }, debug() { throw new Error('logger boom') } },
  })
  const result = await pool.run('agent-a', { command: 'true', timeoutMs: 100 })
  assert.equal(result.stdout, 'ok\n')
  await pool.disposeAll()
})

await test('runOnce: argv carries distro, workdir, env and the command', async () => {
  const { fake, pool } = makePool({ once: () => ({ stdout: 'Linux 6.6\n' }) }, { distro: 'Ubuntu' })
  const result = await pool.runOnce({
    command: 'uname -r',
    workdir: '/home/me',
    env: { WSL_UTF8: '1' },
    timeoutMs: 100,
  })
  assert.equal(result.stdout, 'Linux 6.6\n')
  assert.equal(result.stderr, '')
  assert.equal(result.exitCode, 0)
  assert.equal(result.timeoutMs, 100)
  assert.equal(result.shellRestarted, undefined)
  const spawnOptions = fake.calls[0]
  assert.deepEqual(spawnOptions.argv, ['wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me', '-e', 'bash', '-lc', 'uname -r'])
  assert.deepEqual(spawnOptions.env, { WSL_UTF8: '1' })
  assert.equal(spawnOptions.stdio.stdin, 'ignore')
  assert.equal(fake.calls.length, 1, 'one-shot commands never spawn a persistent shell')
})

await test('runOnce: input is written to stdin as the batch shape', async () => {
  const payload = Buffer.from('hello').toString('base64')
  const { fake, pool } = makePool({ once: () => ({ stdout: 'sha256\n' }) })
  await pool.runOnce({ command: 'base64 -d > /tmp/x', input: payload, timeoutMs: 100 })
  const handle = fake.onceHandles()[0]
  assert.equal(handle.stdinData, payload)
  assert.deepEqual(fake.calls[0].stdio.stdin, { data: payload })
  assert.deepEqual(handle.argv, ['wsl.exe', '-e', 'bash', '-lc', 'base64 -d > /tmp/x'])
})

await test('runOnce: a nonzero exit is reported', async () => {
  const { pool } = makePool({ once: () => ({ stdout: '', stderr: 'head: no such file\n', exitCode: 1 }) })
  const result = await pool.runOnce({ command: 'head -c 1 /nope', timeoutMs: 100 })
  assert.equal(result.exitCode, 1)
  assert.equal(result.stderr, 'head: no such file\n')
})

await test('runOnce: timeout terminates the process and reports timedOut', async () => {
  const { fake, pool } = makePool({ once: () => ({ hang: true }) })
  const result = await pool.runOnce({ command: 'sleep 100', timeoutMs: 25 })
  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
  assert.equal(result.exitCode, TIMEOUT_EXIT_CODE)
  assert.equal(result.timeoutMs, 25)
  assert.equal(fake.onceHandles()[0].terminated, true)
})

await test('runOnce: abort terminates the process and reports aborted', async () => {
  const { fake, pool } = makePool({ once: () => ({ hang: true }) })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10)
  try {
    const result = await pool.runOnce({
      command: 'sleep 100',
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    assert.equal(result.aborted, true)
    assert.equal(result.timedOut, false)
    assert.equal(fake.onceHandles()[0].terminated, true)
  } finally {
    clearTimeout(timer)
  }
})

await test('pool: a spawn failure rejects with a shell-unavailable error', async () => {
  const error = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
  const { pool } = makePool({ spawnError: error })
  await assert.rejects(
    () => pool.run('agent-a', { command: 'true', timeoutMs: 100 }),
    (reason) => reason instanceof ShellUnavailableError && reason.code === 'spawn-failed',
  )
  await assert.rejects(
    () => pool.runOnce({ command: 'true', timeoutMs: 100 }),
    (reason) => reason instanceof ShellUnavailableError && reason.code === 'spawn-failed',
  )
})

await test('pool: dispose and disposeAll stop their shells', async () => {
  const { fake, pool } = makePool({ shell: () => ({ stdout: 'x\n' }) })
  await pool.run('agent-a', { command: 'one', timeoutMs: 100 })
  await pool.run('agent-b', { command: 'two', timeoutMs: 100 })
  assert.equal(pool.size, 2)
  await pool.dispose('agent-a', 'test disposal')
  assert.equal(pool.size, 1)
  assert.equal(pool.has('agent-a'), false)
  assert.equal(fake.shellHandles()[0].terminated, true)
  assert.equal(fake.shellHandles()[1].terminated, false)
  await pool.disposeAll('test teardown')
  assert.equal(pool.size, 0)
  assert.equal(fake.shellHandles()[1].terminated, true)
})

await test('pool: dispose is safe for an unknown agent and never rejects', async () => {
  const { pool } = makePool({})
  await pool.dispose('nobody', 'no shell')
  await pool.disposeAll()
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) {
  for (const failure of failures) console.error('\n' + failure)
  process.exit(1)
}
