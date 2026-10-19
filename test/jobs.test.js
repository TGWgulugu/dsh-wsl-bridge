/**
 * Unit tests for background execution: the argv shape, the job registration,
 * the outcome mapping, and the tool wiring.
 *
 * Run: node test/jobs.test.js
 */
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { BACKGROUND_JOB_KIND, backgroundArgv, startWslBackgroundJob } from '../src/jobs.js'
import { buildTools } from '../src/tools.js'
import { buildWorldTools } from '../src/world-tools.js'

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

/** Fake subprocess service: records spawn options and exposes a handle. */
function makeSubprocess(record) {
  return {
    spawn(options) {
      record.push(options)
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      const handle = {
        done,
        waitForExit: async () => {},
        terminate() {
          handle.terminated = true
          settle({ exitCode: null, signal: 'SIGTERM' })
        },
        collected: {
          stdout: { readFrom: (offset) => ({ text: offset === 0 ? 'hello' : '', nextOffset: 5, lossy: false }) },
          stderr: { readFrom: (offset) => ({ text: '', nextOffset: offset, lossy: false }) },
        },
      }
      setTimeout(() => settle({ exitCode: 0, signal: null }), 5)
      return handle
    },
  }
}

/** Fake job registry capturing the spec. */
function makeJobs(ids = []) {
  return {
    specs: [],
    start(spec) {
      this.specs.push(spec)
      const id = 'dsh-wsl-bridge-' + String(this.specs.length)
      ids.push(id)
      return id
    },
  }
}

const config = resolveConfig({ timeoutMs: 5_000 })
const exec = { agent: { id: 'agent-1', session: { header: { cwd: 'D:\\proj' } } } }

await test('jobs: argv carries the distro and the Linux working directory', () => {
  assert.deepEqual(backgroundArgv({ distro: '' }, undefined), ['wsl.exe', '-e', 'bash', '-s'])
  assert.deepEqual(backgroundArgv({ distro: 'Ubuntu' }, '/home/me/proj'), [
    'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '-e', 'bash', '-s',
  ])
})

await test('jobs: registers one producer with the host registry', async () => {
  const spawns = []
  const subprocess = makeSubprocess(spawns)
  const jobs = makeJobs()
  const id = startWslBackgroundJob({
    subprocess, jobs, config, owner: 'agent-1', script: 'sleep 5; echo done', label: 'build', workdir: '/tmp',
  })
  assert.equal(id, 'dsh-wsl-bridge-1')
  const spec = jobs.specs[0]
  assert.equal(spec.kind, BACKGROUND_JOB_KIND)
  assert.equal(spec.owner, 'agent-1')
  assert.equal(spec.output.length, 2)
  // A read before the spawn is empty by design: the registry may pump first.
  assert.deepEqual(spec.output[0].read(0), { text: '', nextOffset: 0, lossy: false })

  const hooks = spec.run({ id, append() {} })
  assert.deepEqual(spec.output[0].read(0), { text: 'hello', nextOffset: 5, lossy: false })
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].argv[0], 'wsl.exe')
  assert.deepEqual(spawns[0].argv.slice(-2), ['bash', '-s'])
  assert.equal(spawns[0].stdio.stdin.data, 'sleep 5; echo done')
  assert.equal(spawns[0].stdio.stdout.maxBytes > 0, true)

  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.detail, 'exit code: 0')
})

await test('jobs: cancel terminates the process and reports killed', async () => {
  const spawns = []
  const jobs = makeJobs()
  startWslBackgroundJob({
    subprocess: makeSubprocess(spawns), jobs, config, owner: 'a', script: 'sleep 100', label: 'slow',
  })
  const hooks = jobs.specs[0].run({ id: 'dsh-wsl-bridge-1', append() {} })
  hooks.cancel('stop')
  const outcome = await hooks.done
  assert.equal(outcome.status, 'killed')
})

await test('jobs: a spawn failure maps to failed, not a throw', async () => {
  const jobs = makeJobs()
  const failing = { spawn() { throw new Error('spawn EPERM') } }
  startWslBackgroundJob({
    subprocess: failing, jobs, config, owner: 'a', script: 'true', label: 'x',
  })
  const hooks = jobs.specs[0].run({ id: 'dsh-wsl-bridge-1', append() {} })
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /EPERM/u)
})

await test('wsl_bash: runInBackground returns the job id and never touches the shell pool', async () => {
  const calls = []
  const pool = {
    async run(key, request) { calls.push(request); return { stdout: '', stderr: '', exitCode: 0 } },
    async runOnce() { throw new Error('not used') },
  }
  const jobs = makeJobs()
  const tools = new Map(buildTools({
    pool, config, jobs, subprocess: makeSubprocess([]),
  }).map((tool) => [tool.name, tool]))
  const value = await tools.get('wsl_bash').execute({
    command: 'make build', description: 'build', runInBackground: true,
  }, exec)
  assert.equal(value.exitCode, 0)
  assert.match(value.text, /Started background job dsh-wsl-bridge-1/u)
  assert.equal(calls.length, 0)
  assert.equal(jobs.specs[0].owner, 'agent-1')
})

await test('wsl_bash: background without a job registry is refused clearly', async () => {
  const pool = { async run() { throw new Error('not used') }, async runOnce() { throw new Error('not used') } }
  const tools = new Map(buildTools({ pool, config }).map((tool) => [tool.name, tool]))
  const value = await tools.get('wsl_bash').execute({
    command: 'make build', description: 'build', runInBackground: true,
  }, exec)
  assert.equal(value.exitCode, 1)
  assert.match(value.text, /BACKGROUND_UNAVAILABLE/u)
})

await test('wsl_bash: background respects the backgroundJobs config switch', async () => {
  const pool = { async run() { throw new Error('not used') }, async runOnce() { throw new Error('not used') } }
  const tools = new Map(buildTools({
    pool, config: { ...config, backgroundJobs: false }, jobs: makeJobs(), subprocess: makeSubprocess([]),
  }).map((tool) => [tool.name, tool]))
  const value = await tools.get('wsl_bash').execute({
    command: 'true', description: 'x', runInBackground: true,
  }, exec)
  assert.match(value.text, /BACKGROUND_DISABLED/u)
})

await test('world bash: runInBackground works in a WSL session too', async () => {
  const jobs = makeJobs()
  const tools = new Map(buildWorldTools({
    pool: { async run() { throw new Error('not used') }, async runOnce() { throw new Error('not used') } },
    config, jobs, subprocess: makeSubprocess([]),
  }).map((tool) => [tool.name, tool]))
  const value = await tools.get('bash').execute({
    command: 'npm run build', description: 'build', runInBackground: true,
  }, exec)
  assert.equal(value.exitCode, 0)
  assert.match(value.text, /Started background job/u)
})

await test('jobs: the destructive guard runs before a background registration', async () => {
  const jobs = makeJobs()
  const tools = new Map(buildTools({
    pool: { async run() { throw new Error('not used') }, async runOnce() { throw new Error('not used') } },
    config, jobs, subprocess: makeSubprocess([]),
  }).map((tool) => [tool.name, tool]))
  const value = await tools.get('wsl_bash').execute({
    command: 'rm -rf build', description: 'clean', runInBackground: true,
  }, exec)
  assert.match(value.text, /\[blocked\]/u)
  assert.equal(jobs.specs.length, 0)
})

for (const [build, name] of [[buildTools, 'wsl_bash'], [buildWorldTools, 'bash']]) {
  await test(name + ': background keeps session cwd after a persistent call', async () => {
    const spawns = []
    const jobs = makeJobs()
    const pool = { has: () => true }
    const tool = build({ pool, config, jobs, subprocess: makeSubprocess(spawns) }).find((tool) => tool.name === name)
    await tool.execute({ command: 'pwd', description: 'cwd', runInBackground: true }, exec)
    await jobs.specs[0].run().done
    assert.equal(spawns[0].argv[spawns[0].argv.indexOf('--cd') + 1], '/mnt/d/proj')
  })
}

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) {
  for (const failure of failures) console.error('\n' + failure)
  process.exit(1)
}
