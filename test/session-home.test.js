/**
 * Unit tests for moving a WSL session's working directory onto $HOME.
 * Run: node test/session-home.test.js
 */
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { homeRoute, isLoopback } from '../src/home-route.js'
import {
  ensureWslHomeWorkspace, parseHomeProbe, sameWindowsDirectory,
} from '../src/session-home.js'

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

await test('probe: last markers win and a drive path is accepted', () => {
  const parsed = parseHomeProbe('noise\n__WSL_HOME__/tmp\n__WSL_HOME__/home/me\n__WSL_WINHOME__C:/Users/me\n')
  assert.deepEqual(parsed, { linux: '/home/me', windows: 'C:\\Users\\me' })
  assert.equal(parseHomeProbe('__WSL_HOME__relative\n__WSL_WINHOME__\\\\wsl.localhost\\Ubuntu\\home\\me\n'), null)
  assert.equal(parseHomeProbe(''), null)
})

await test('paths: windows directory compare ignores slash and case', () => {
  assert.equal(sameWindowsDirectory('\\\\wsl.localhost\\Ubuntu\\home\\me\\', '\\\\wsl.localhost\\ubuntu\\home\\me'), true)
  assert.equal(sameWindowsDirectory('D:\\proj', 'D:\\other'), false)
})

await test('registry: the probed home path is registered once', async () => {
  const created = []
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { create: async (path) => { created.push(path) } }
      return undefined
    },
  }
  const pool = {
    async runOnce() {
      return {
        stdout: '__WSL_HOME__/home/me\n__WSL_WINHOME__\\\\wsl.localhost\\Ubuntu\\home\\me\n',
        stderr: '',
        exitCode: 0,
      }
    },
  }
  await ensureWslHomeWorkspace(ctx, { pool, config: resolveConfig({ fileTimeoutMs: 5_000 }) })
  assert.deepEqual(created, ['\\\\wsl.localhost\\Ubuntu\\home\\me'])
})

await test('route: home path is the probe result and is not served off loopback', async () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.2' } }), false)
  const route = homeRoute(async () => '\\\\wsl$\\OtherDistro\\root')
  const ok = respond()
  route.handler({ method: 'GET', socket: { remoteAddress: '::1' } }, ok.res)
  await flush()
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body), { path: '\\\\wsl$\\OtherDistro\\root' })
  const denied = respond()
  route.handler({ method: 'GET', socket: { remoteAddress: '10.0.0.8' } }, denied.res)
  assert.equal(denied.status, 403)
})

function respond() {
  const out = { status: 0, body: '' }
  out.res = {
    writeHead(status) { out.status = status },
    end(payload) { out.body = String(payload) },
  }
  return out
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

if (failed > 0) {
  console.error(failures.join('\n\n'))
  process.exit(1)
}
console.log(passed + ' passed')
