/**
 * Directory listing for the WSL folder picker.
 * Run: node test/dir-list.test.js
 */
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { directoryListCommand, isListedLinuxPath, parseDirectoryListing } from '../src/dir-list.js'
import { dirRoute } from '../src/dir-route.js'

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

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64')
}

await test('command: home is not a baked-in path, and a chosen path cannot break the shell', () => {
  const home = directoryListCommand('')
  assert.match(home, /dir=\$HOME/)
  assert.equal(home.includes('base64 -d'), false)
  const chosen = directoryListCommand("/tmp/a'b$(reboot)")
  assert.equal(chosen.includes("/tmp/a'b$(reboot)"), false)
  assert.match(chosen, /base64 -d/)
  assert.equal(isListedLinuxPath('relative'), false)
  assert.equal(isListedLinuxPath('/'), true)
  assert.throws(() => directoryListCommand('tmp'), /path rejected/)
})

await test('parse: markers survive login noise and keep the windows path', () => {
  const stdout = [
    'welcome',
    '__WSL_CWD__' + encode('/home/me'),
    '__WSL_CWDWIN__' + encode('\\\\wsl.localhost\\Ubuntu\\home\\me'),
    '__WSL_PARENT__' + encode('/home'),
    '__WSL_PARENTWIN__' + encode('\\\\wsl.localhost\\Ubuntu\\home'),
    '__WSL_NAME__' + encode('src'),
    '__WSL_NAME__' + encode('docs'),
  ].join('\n')
  const listing = parseDirectoryListing(stdout)
  assert.equal(listing.path, '/home/me')
  assert.equal(listing.windows, '\\\\wsl.localhost\\Ubuntu\\home\\me')
  assert.equal(listing.parent.path, '/home')
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['docs', 'src'])
  assert.equal(listing.entries[1].path, '/home/me/src')
  assert.equal(listing.entries[1].windows, '\\\\wsl.localhost\\Ubuntu\\home\\me\\src')
  assert.equal(parseDirectoryListing('no markers'), null)
})

await test('route: lists the probed directory on loopback only', async () => {
  const stdout = [
    '__WSL_CWD__' + encode('/srv/app'),
    '__WSL_CWDWIN__' + encode('\\\\wsl$\\Debian\\srv\\app'),
  ].join('\n')
  const pool = {
    async runOnce(request) {
      assert.equal(request.command.includes('/srv/app'), false)
      assert.match(request.command, /base64 -d/)
      return { stdout, stderr: '', exitCode: 0 }
    },
  }
  const route = dirRoute(pool, resolveConfig({ fileTimeoutMs: 5_000 }))
  const ok = respond()
  route.handler({
    method: 'GET',
    url: '/api/dsh-wsl-bridge/dirs?path=' + encodeURIComponent('/srv/app'),
    socket: { remoteAddress: '127.0.0.1' },
  }, ok.res)
  await flush()
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).path, '/srv/app')
  const denied = respond()
  route.handler({
    method: 'GET',
    url: '/api/dsh-wsl-bridge/dirs',
    socket: { remoteAddress: '10.1.1.1' },
  }, denied.res)
  assert.equal(denied.status, 403)
  const rejected = respond()
  route.handler({
    method: 'GET',
    url: '/api/dsh-wsl-bridge/dirs?path=relative',
    socket: { remoteAddress: '::1' },
  }, rejected.res)
  assert.equal(rejected.status, 400)
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
