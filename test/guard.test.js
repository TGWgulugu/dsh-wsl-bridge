/**
 * Unit tests for the destructive-command guard and its wiring into both bash
 * tools (host `wsl_bash` and the WSL-preset `bash`).
 *
 * Run: node test/guard.test.js
 */
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { checkDangerous } from '../src/guard.js'
import { buildTools } from '../src/tools.js'
import { buildWorldTools } from '../src/world-tools.js'
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

/** Pool that records calls and answers success. */
function makePool() {
  const calls = []
  return {
    calls,
    async run(_key, request) {
      calls.push(request)
      return { stdout: 'ok\n', stderr: '', exitCode: 0, timeoutMs: request.timeoutMs, signal: null, timedOut: false, aborted: false }
    },
    async runOnce(request) {
      calls.push(request)
      return { stdout: '', stderr: '', exitCode: 0, timeoutMs: request.timeoutMs, signal: null, timedOut: false, aborted: false }
    },
    dispose() {},
    disposeAll() {},
  }
}

const config = resolveConfig({ timeoutMs: 5_000, fileTimeoutMs: 5_000 })
const exec = { agent: { session: { header: { cwd: 'D:\\proj' } } } }

await test('guard: ordinary commands pass', () => {
  for (const command of ['ls -la', 'npm test', 'rm -f one.txt', 'git status', 'echo "rm -rf is a phrase"']) {
    assert.equal(checkDangerous(command), null, command)
  }
})

await test('guard: recursive delete is refused', () => {
  for (const command of ['rm -rf build', 'rm -r x', 'rm -R x', 'rm --recursive x', 'sudo rm -rf /tmp/x']) {
    assert.match(String(checkDangerous(command)), /recursive delete/u, command)
  }
})

await test('guard: device, power and find/git cases are refused', () => {
  assert.match(String(checkDangerous('find . -delete')), /find -delete/u)
  assert.match(String(checkDangerous('dd if=image of=/dev/sdb')), /dd onto a block device/u)
  assert.match(String(checkDangerous('mkfs.ext4 /dev/sda1')), /formatting/u)
  assert.match(String(checkDangerous('sudo reboot')), /power control/u)
  assert.match(String(checkDangerous('systemctl poweroff')), /power control/u)
  assert.match(String(checkDangerous('git clean -fdx')), /git clean/u)
  assert.match(String(checkDangerous(':(){ :|:& };:')), /fork bomb/u)
})

await test('guard: one dangerous segment of many is enough', () => {
  assert.match(String(checkDangerous('echo ok && rm -rf build')), /recursive delete/u)
  assert.match(String(checkDangerous('cd /tmp; rm -r x')), /recursive delete/u)
})

await test('wsl_bash: a destructive command is blocked without allowDangerous', async () => {
  const pool = makePool()
  const tools = new Map(buildTools({ pool, config }).map((tool) => [tool.name, tool]))
  const value = await tools.get('wsl_bash').execute({ command: 'rm -rf build', description: 'clean' }, exec)
  assert.equal(value.exitCode, 1)
  assert.match(value.text, /\[blocked\]/u)
  assert.equal(pool.calls.length, 0, 'nothing may reach the shell')
})

await test('wsl_bash: allowDangerous lets the command through', async () => {
  const pool = makePool()
  const tools = new Map(buildTools({ pool, config }).map((tool) => [tool.name, tool]))
  const value = await tools.get('wsl_bash').execute({
    command: 'rm -rf build', description: 'clean', allowDangerous: true,
  }, exec)
  assert.equal(value.exitCode, 0)
  assert.equal(pool.calls.length, 1)
})

await test('world bash: the same guard applies in a WSL session', async () => {
  const pool = makePool()
  const tools = new Map(buildWorldTools({ pool, config }).map((tool) => [tool.name, tool]))
  const blocked = await tools.get('bash').execute({ command: 'rm -r x', description: 'clean' }, exec)
  assert.equal(blocked.exitCode, 1)
  assert.match(blocked.text, /\[blocked\]/u)
  assert.equal(pool.calls.length, 0)
})

await test('config: dangerGuard can be switched off for a profile', async () => {
  const pool = makePool()
  const relaxed = resolveConfig({ dangerGuard: false, timeoutMs: 5_000 })
  const tools = new Map(buildTools({ pool, config: relaxed }).map((tool) => [tool.name, tool]))
  const value = await tools.get('wsl_bash').execute({ command: 'rm -rf build', description: 'clean' }, exec)
  assert.equal(value.exitCode, 0)
  assert.equal(pool.calls.length, 1)
})

await test('config: dangerGuard must be a boolean', () => {
  assert.throws(() => resolveConfig({ dangerGuard: 'yes' }), /config\.dangerGuard/u)
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) {
  for (const failure of failures) console.error('\n' + failure)
  process.exit(1)
}
