// Opt-in real WSL regression suite. All fixtures live in a unique /tmp directory.
// The subprocess adapter exercises the real command strings; host composition is
// verified separately with the DSH integration probe.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createShellPool } from '../src/shell.js'
import { readText, writeText, editText, shellQuote as q } from '../src/fsops.js'
import { grepFiles, globFiles } from '../src/search.js'
import { buildTools } from '../src/tools.js'
import { buildWorldTools } from '../src/world-tools.js'
import { resolveConfig } from '../src/config.js'

function spawnProcess(options) {
  const child = spawn(options.argv[0], options.argv.slice(1), { windowsHide: true, stdio: 'pipe' })
  const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
  for (const name of Object.keys(buffers)) {
    child[name].on('data', (chunk) => { buffers[name] = Buffer.concat([buffers[name], chunk]) })
  }
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  child.stdin.on('error', () => {})
  const input = options.stdio.stdin
  if (input !== 'pipe') child.stdin.end(typeof input === 'object' ? input.data : undefined)
  return {
    done, stdin: child.stdin, waitForExit: () => done, terminate: () => child.kill(),
    collected: Object.fromEntries(Object.keys(buffers).map((name) => [name, {
      readFrom(offset) {
        return { text: buffers[name].subarray(offset).toString('utf8'), nextOffset: buffers[name].length, lossy: false }
      },
    }])),
  }
}

const pool = createShellPool({ spawn: spawnProcess, config: { timeoutMs: 30_000 } })
const once = async (command) => {
  const value = await pool.runOnce({ command })
  assert.equal(value.exitCode, 0, value.stderr)
  return value.stdout.trim()
}
const root = await once('mktemp -d /tmp/dsh-wsl-bridge-test.XXXXXXXX')
assert.match(root, /^\/tmp\/dsh-wsl-bridge-test\.[A-Za-z0-9]+$/)
let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log('ok   ' + name)
}
try {
  const file = root + "/quote' 中文.txt"
  await test('files: UTF-8 and quoted paths round-trip; literal replacement; mode preserved', async () => {
    await writeText(pool, { path: file, text: 'hello OLD 中文\n' })
    await once('chmod 755 -- ' + q(file))
    const result = await editText(pool, { path: file, oldString: 'OLD', newString: '$& $$' })
    assert.equal(result.ok, true)
    assert.equal((await readText(pool, { path: file })).text, 'hello $& $$ 中文\n')
    assert.equal(await once('stat -c %a -- ' + q(file)), '755')
  })
  await test('files: missing file and directory reads fail', async () => {
    await assert.rejects(() => readText(pool, { path: root + '/missing' }), /cannot read/)
    await assert.rejects(() => readText(pool, { path: root }), /cannot read/)
  })
  await test('files: directory writes fail without leaving temp files', async () => {
    await assert.rejects(() => writeText(pool, { path: root, text: 'wrong' }), /cannot write/)
    assert.equal(await once('find ' + q(root) + ' -name ' + q('.dsh-wsl-bridge.*')), '')
  })
  await test('files: concurrent edit and deletion are stale, never overwritten or recreated', async () => {
    for (const remove of [false, true]) {
      await writeText(pool, { path: file, text: 'original' })
      const racingPool = { async runOnce(req) {
        const result = await pool.runOnce(req)
        if (req.input === undefined) {
          if (remove) await once('rm -f -- ' + q(file))
          else await writeText(pool, { path: file, text: 'concurrent' })
        }
        return result
      } }
      assert.equal((await editText(racingPool, { path: file, oldString: 'original', newString: 'edit' })).code, 'stale')
      if (remove) await assert.rejects(() => readText(pool, { path: file }), /cannot read/)
      else assert.equal((await readText(pool, { path: file })).text, 'concurrent')
    }
  })
  await test('search: hidden entries and node_modules excluded; single-file grep has path and line', async () => {
    await once('mkdir -p -- ' + q(root + '/.hidden') + ' ' + q(root + '/node_modules'))
    for (const name of ['visible.txt', '.env', '.hidden/a.txt', 'node_modules/a.txt']) {
      await writeText(pool, { path: root + '/' + name, text: 'needle\n' })
    }
    const grep = await grepFiles(pool, { root, pattern: 'needle' })
    assert.equal(grep.error, null)
    assert.deepEqual(grep.matches, ['visible.txt:1:needle'])
    const single = await grepFiles(pool, { root: root + '/visible.txt', pattern: 'needle' })
    assert.deepEqual(single.matches, [root + '/visible.txt:1:needle'])
    assert.deepEqual((await globFiles(pool, { root, pattern: '*' })).files, ['visible.txt'])
  })
  await test('search: missing roots and invalid regex report failures', async () => {
    assert.notEqual((await grepFiles(pool, { root: root + '/missing', pattern: 'x' })).error, null)
    assert.notEqual((await grepFiles(pool, { root, pattern: '(' })).error, null)
    await assert.rejects(() => globFiles(pool, { root: root + '/missing', pattern: '*' }), /glob failed/)
  })
  await test('shell: failed cwd prevents every line and leaves shell usable', async () => {
    const bad = await pool.run('bad-cwd', { workdir: root + '/missing', command: 'echo FIRST; echo SECOND\necho THIRD' })
    assert.notEqual(bad.exitCode, 0)
    assert.equal(bad.stdout, '')
    assert.equal((await pool.run('bad-cwd', { command: 'echo alive' })).stdout.trim(), 'alive')
  })
  for (const [build, name] of [[buildTools, 'wsl_bash'], [buildWorldTools, 'bash']]) {
    await test(name + ': persistent cwd/export, isolated background cwd, file tools', async () => {
      const config = resolveConfig({ defaultWorkdir: root })
      const exec = { agent: { id: name, session: { header: { cwd: root } } } }
      let hooks
      let spec
      const jobs = { start(value) { spec = value; hooks = value.run(); return 'integration-job' } }
      const tools = build({ pool, config, jobs, subprocess: { spawn: spawnProcess } })
      const bash = tools.find((tool) => tool.name === name)
      await bash.execute({ command: 'cd /tmp; export BRIDGE_TEST=kept', description: 'persist' }, exec)
      const next = await bash.execute({ command: 'printf "%s|%s" "$PWD" "$BRIDGE_TEST"', description: 'check' }, exec)
      assert.match(next.text, /\/tmp\|kept/)
      assert.equal((await bash.execute({ command: 'pwd', description: 'background', runInBackground: true }, exec)).exitCode, 0)
      assert.equal((await hooks.done).status, 'completed')
      assert.equal(spec.output[0].read(0).text.trim(), root)
      const prefix = name === 'bash' ? '' : 'wsl_'
      const path = root + '/tools.txt'
      await tools.find((t) => t.name === prefix + 'write').execute({ path, content: 'before' }, exec)
      await tools.find((t) => t.name === prefix + 'edit').execute({ path, oldString: 'before', newString: 'after' }, exec)
      assert.equal((await tools.find((t) => t.name === prefix + 'read').execute({ path }, exec)).text, 'after')
    })
  }
  console.log('\n' + passed + ' real WSL checks passed')
} finally {
  await pool.disposeAll()
  // Only the unique mktemp path validated above is removed, entirely inside WSL.
  await once('rm -rf -- ' + q(root))
}
