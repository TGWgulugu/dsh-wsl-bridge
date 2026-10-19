/**
 * Phase 1 integration self-check (opt-in).
 *
 * Runs only when `config.selfCheck` is true (or `DSH_WSL_BRIDGE_SELFCHECK=1`),
 * and only from the real host process — that is the one place where `wsl.exe`
 * can be spawned through `ctx.subprocess` without a sandboxed token. It proves
 * the four seams the tools sit on:
 *   1. a one-shot WSL command (distro/kernel/user),
 *   2. a persistent shell whose `cd` survives a second call,
 *   3. the file round trip that depends on the batch stdin shape
 *      (`runOnce({ input })` -> `base64 -d`), and
 *   4. the sha256-fenced edit path.
 *
 * The record goes to the host log and, when a path is configured, to that file.
 *
 * @module dsh-wsl-bridge/self-check
 */
import { appendFileSync } from 'node:fs'
import { editText, readText, writeText } from './fsops.js'
import { startWslBackgroundJob } from './jobs.js'

/**
 * @param {object} ctx - cordis context (logging only).
 * @param {object} pool - shell pool.
 * @param {object} config - resolved bridge config.
 * @param {object[]} tools - the registered tool definitions.
 */
function step(config, label) {
  if (config.selfCheckMarker === '') return
  try {
    appendFileSync(config.selfCheckMarker, '[self-check] ' + label + ' ' + new Date().toISOString() + '\n')
  } catch {
    // diagnostic only
  }
}

export async function runSelfCheck(ctx, pool, config, tools, services = {}) {
  if (config.selfCheckMarker !== '') {
    try {
      appendFileSync(config.selfCheckMarker, '[self-check] started ' + new Date().toISOString() + '\n')
    } catch {
      // diagnostic only
    }
  }
  const lines = [
    '[dsh-wsl-bridge self-check] ' + new Date().toISOString(),
    'platform=' + process.platform,
    'distro=' + (config.distro === '' ? '(default)' : config.distro),
    'tools=' + tools.map((tool) => tool.name).join(','),
  ]

  const timeoutMs = config.selfCheckTimeoutMs
  step(config, 'one-shot-start')
  try {
    const once = await pool.runOnce({
      command: 'uname -sr; whoami; pwd; node -v 2>/dev/null || echo NO_NODE',
      timeoutMs,
    })
    lines.push('one-shot exitCode=' + String(once.exitCode))
    lines.push('one-shot stdout=' + once.stdout.trim())
    if (once.stderr.trim() !== '') lines.push('one-shot stderr=' + once.stderr.trim())
  } catch (error) {
    lines.push('one-shot ERROR=' + messageOf(error))
  }

  step(config, 'persistent-start')
  try {
    const key = { id: 'dsh-wsl-bridge-self-check' }
    const first = await pool.run(key, { command: 'cd /tmp && echo FIRST:$PWD', timeoutMs })
    const second = await pool.run(key, { command: 'echo SECOND:$PWD', timeoutMs })
    const persisted = second.stdout.includes('SECOND:/tmp')
    lines.push('persistent cd=' + (persisted ? 'OK' : 'MISMATCH'))
    lines.push('persistent first=' + first.stdout.trim() + ' second=' + second.stdout.trim())
    pool.dispose(key, 'self-check finished')
  } catch (error) {
    lines.push('persistent ERROR=' + messageOf(error))
  }

  step(config, 'file-start')
  const path = '/tmp/dsh-wsl-bridge-selfcheck-' + String(process.pid) + '.txt'
  try {
    const payload = 'hello from dsh-wsl-bridge\nsecond line\n'
    const written = await writeText(pool, { path, text: payload, timeoutMs })
    const read = await readText(pool, { path, maxBytes: 1_024, timeoutMs })
    const edited = await editText(pool, { path, oldString: 'second', newString: 'SECOND', timeoutMs })
    const after = await readText(pool, { path, maxBytes: 1_024, timeoutMs })
    lines.push('file write=' + (written.ok ? 'OK' : 'FAILED'))
    lines.push('file round-trip=' + (read.text === payload ? 'OK' : 'MISMATCH'))
    lines.push('file edit=' + (after.text === 'hello from dsh-wsl-bridge\nSECOND line\n' ? 'OK' : 'MISMATCH')
      + ' (replacements=' + String(edited.replacements) + ')')
    await pool.runOnce({ command: 'rm -f -- ' + quote(path), timeoutMs })
  } catch (error) {
    lines.push('file ERROR=' + messageOf(error))
  }

  step(config, 'tool-start')
  // Tool layer end to end: a real execute() through the registered definition,
  // including the session-cwd -> /mnt/<drive> default workdir translation.
  try {
    const bash = tools.find((tool) => tool.name === 'wsl_bash')
    const exec = { agent: { session: { header: { cwd: 'D:\\try\\experiment' } } } }
    const value = await bash.execute({ command: 'echo TOOL_LAYER_OK; pwd', description: 'self-check' }, exec)
    const ok = value.text.includes('TOOL_LAYER_OK') && value.text.includes('/mnt/d/try/experiment')
    lines.push('tool wsl_bash=' + (ok ? 'OK' : 'MISMATCH') + ' exit=' + String(value.exitCode))
    lines.push('tool output=' + value.text.trim().replace(/\n/gu, ' | '))
    await bash.execute({ command: 'cd /tmp && pwd', description: 'self-check cd' }, exec)
    const persisted = await bash.execute({ command: 'pwd', description: 'self-check pwd' }, exec)
    lines.push('tool cd persistence=' + (persisted.text.includes('/tmp') ? 'OK' : 'MISMATCH'))
    pool.dispose(exec.agent, 'self-check tool shell')
  } catch (error) {
    lines.push('tool ERROR=' + messageOf(error))
  }

  // Opt-in: prove the real host job registry accepts a WSL background command
  // and that the job really runs (it writes a file inside the distribution).
  if (process.env.DSH_WSL_BRIDGE_JOB_SELFCHECK === '1') {
    try {
      if (services.jobs === undefined || services.subprocess === undefined) {
        lines.push('job registry=unavailable')
      } else {
        const markerPath = '/tmp/dsh-wsl-bridge-job-' + String(process.pid) + '.txt'
        await pool.runOnce({ command: 'rm -f -- ' + quote(markerPath), timeoutMs })
        const id = startWslBackgroundJob({
          subprocess: services.subprocess,
          jobs: services.jobs,
          config,
          owner: 'dsh-wsl-bridge-self-check',
          script: 'sleep 1; echo JOB_OK > ' + quote(markerPath),
          label: 'dsh-wsl-bridge self-check background',
          workdir: '/tmp',
        })
        lines.push('job id=' + id)
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        const check = await pool.runOnce({
          command: 'cat -- ' + quote(markerPath) + ' 2>/dev/null || echo MISSING',
          timeoutMs,
        })
        lines.push('job file=' + check.stdout.trim())
        await pool.runOnce({ command: 'rm -f -- ' + quote(markerPath), timeoutMs })
      }
    } catch (error) {
      const message = messageOf(error)
      // A probe has no live agent, and the registry correctly refuses an owner
      // that does not exist; that refusal still proves the registry is reachable.
      lines.push(message.includes('no live agent')
        ? 'job registry=reachable (fake owner refused as expected)'
        : 'job ERROR=' + message)
    }
  }

  const record = lines.join('\n') + '\n'
  ctx.logger?.info?.(record.trim())
  if (config.selfCheckMarker !== '') {
    try {
      appendFileSync(config.selfCheckMarker, record)
    } catch (error) {
      ctx.logger?.warn?.('dsh-wsl-bridge: self-check marker not written: ' + messageOf(error))
    }
  }
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Single-quote a value for bash. */
function quote(value) {
  return "'" + String(value).replace(/'/gu, "'\\''") + "'"
}
