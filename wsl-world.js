/**
 * dsh-wsl-bridge — `WSL` agent preset entry (Phase 2).
 *
 * A preset mounts this module as `dsh-wsl-bridge/wsl-world`. It registers the
 * `bash`, `read`, `write`, `edit`, `grep`, `glob` and `wsl_env` tools *inside
 * the preset's scope*, so a session created with the `WSL` mode works entirely
 * in Linux paths while a normal session keeps the host's own tools untouched.
 *
 * It deliberately provides no services (no `ctx.shell` / `ctx.fs` replacement):
 * a preset-scope tool set is the smallest mechanism that gives one session a
 * different execution world without touching the global shell/fs seams.
 *
 * @module dsh-wsl-bridge/wsl-world
 */
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './src/config.js'
import { windowsPathToLinux } from './src/paths.js'
import { createShellPool } from './src/shell.js'
import { buildWorldTools } from './src/world-tools.js'

/** Cordis plugin name for this entry (the loader row id is separate). */
export const name = 'dsh-wsl-bridge:wsl-world'

/** Required services only: the tool registry and the subprocess seam. */
export const inject = ['tools', 'subprocess']

/**
 * Mount the WSL world.
 *
 * @param {object} ctx - preset-scope cordis context.
 * @param {object} [rawConfig] - the preset row's `config` block.
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = resolveConfig(rawConfig)
  } catch (error) {
    ctx.logger?.error?.('wsl-world: ' + messageOf(error))
    return
  }
  if (process.platform !== 'win32') {
    ctx.logger?.info?.('wsl-world: not mounted (host platform is ' + process.platform + ')')
    return
  }

  // Capture the service object while the context is active: a preset plugin's
  // ctx becomes inactive after activation commits, and a late property lookup
  // on it throws `cannot get required service "subprocess" in inactive context`.
  // The service object itself outlives the activation.
  const subprocess = ctx.subprocess
  const jobs = readService(ctx, 'jobs')
  const pool = createShellPool({
    spawn: (options) => subprocess.spawn(options),
    config,
    logger: ctx.logger,
  })
  ctx.effect(() => () => pool.disposeAll(), 'wsl-world: shell pool')
  ctx.on('agent/disposed', ({ agent }) => {
    pool.dispose(agent, 'agent disposed')
  })

  const tools = buildWorldTools({ pool, config, subprocess, jobs })
  for (const tool of tools) {
    ctx.effect(() => {
      const unregister = ctx.tools.register(tool)
      return () => unregister()
    }, 'wsl-world: ' + tool.name)
  }

  const names = tools.map((tool) => tool.name).join(',')
  ctx.logger?.info?.('wsl-world: mounted tools=' + names)

  // Integration hook: a preset mounts eagerly at boot, so this marker proves the
  // declaration composed and the world registered its tool set.
  const marker = process.env.DSH_WSL_BRIDGE_WORLD_MARKER ?? ''
  if (marker !== '') {
    try {
      appendFileSync(marker, '[wsl-world] mount ' + new Date().toISOString()
        + ' distro=' + (config.distro === '' ? '(default)' : config.distro)
        + ' tools=' + names + ' jobs=' + String(jobs !== undefined) + '\n')
    } catch {
      // diagnostic only
    }
  }

  if (process.env.DSH_WSL_BRIDGE_WORLD_SELFCHECK === '1') {
    void worldSelfCheck(ctx, pool, tools, marker)
  }
}

/**
 * Prove the preset-scope tool set actually executes: call the registered
 * `bash` tool through its own definition (no agent loop needed).
 *
 * @param {object} ctx
 * @param {object[]} tools
 * @param {string} marker
 */
async function worldSelfCheck(ctx, pool, tools, marker) {
  const lines = ['[wsl-world self-check] ' + new Date().toISOString()]
  // Preset activation is a transaction: a child spawned while it is settling can
  // be reaped. A real session's first tool call happens long after activation,
  // so the probe waits one tick and retries once, recording both attempts.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  const bash = tools.find((tool) => tool.name === 'bash')
  const packageDir = fileURLToPath(new URL('.', import.meta.url))
  const linuxDir = windowsPathToLinux(packageDir)?.replace(/\/+$/u, '') ?? ''
  const exec = { agent: { session: { header: { cwd: packageDir } } } }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const value = await bash.execute({ command: 'echo WORLD_OK; pwd', description: 'world self-check' }, exec)
      lines.push('attempt' + String(attempt) + ' exit=' + String(value.exitCode))
      lines.push('attempt' + String(attempt) + ' output=' + value.text.trim().replace(/\n/gu, ' | '))
      if (value.exitCode === 0) break
    } catch (error) {
      lines.push('attempt' + String(attempt) + ' ERROR=' + messageOf(error))
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  // Real grep / glob against this package, through the same preset-scope tools.
  if (linuxDir === '') {
    lines.push('search SKIP=package path is not a Windows path')
  } else {
    try {
      const grep = tools.find((tool) => tool.name === 'grep')
      const hit = await grep.execute({
        pattern: 'dsh-wsl-bridge',
        path: linuxDir + '/README.md',
      }, exec)
      lines.push('grep exit=' + String(hit.exitCode) + ' first=' + hit.text.split('\n').slice(0, 2).join(' | '))
      const glob = tools.find((tool) => tool.name === 'glob')
      const files = await glob.execute({
        pattern: '*.js',
        path: linuxDir + '/src',
      }, exec)
      lines.push('glob count=' + String(files.text.split('\n').filter((line) => line !== '').length)
        + ' first=' + files.text.split('\n')[0])
    } catch (error) {
      lines.push('search ERROR=' + messageOf(error))
    }
  }
  pool.dispose(exec.agent, 'world self-check shell')
  const record = lines.join('\n') + '\n'
  ctx.logger?.info?.(record.trim())
  if (marker !== '') {
    try {
      appendFileSync(marker, record)
    } catch {
      // diagnostic only
    }
  }
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read an optional service without failing the mount when it is absent.
 * @param {object} ctx
 * @param {string} name
 * @returns {object|undefined}
 */
function readService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}
