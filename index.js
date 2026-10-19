/**
 * dsh-wsl-bridge — Phase 1 host half.
 *
 * Gives every session a native Linux (= WSL) execution surface on a Windows
 * host without starting another web server and without installing anything
 * inside the distribution:
 *
 *   wsl_bash   persistent `bash` inside the default (or configured) WSL distro
 *   wsl_read   read a Linux path (binary safe, base64 round trip)
 *   wsl_write  atomically write a Linux path (optional sha256 version guard)
 *   wsl_edit   read-modify-write with a sha256 fence against concurrent edits
 *   wsl_path   Windows <-> Linux path conversion (wslpath first, mapping fallback)
 *   wsl_env    distro / kernel / user / toolchain report
 *
 * Design constraints (see _scratch/p1/DESIGN.md in the development workspace):
 *  - ZERO dependencies and NO build step: only Node built-ins are imported, so
 *    the package mounts from a profile `node_modules` directory without the
 *    host's package-resolution interception biting (a `file:` row outside the
 *    profiles tree cannot resolve `@deepseek-ai/*` on DSH 0.2.1).
 *  - Tools are registered with raw JSON Schema definitions instead of
 *    `defineTool()` from `@deepseek-ai/dsh-tools` (that helper is only a terse
 *    spec -> JSON Schema converter; the registry accepts hand-written schemas).
 *  - Registering nothing is better than failing the boot: a missing `wsl.exe`
 *    is reported by the tools, never thrown from `apply()`.
 *
 * @module dsh-wsl-bridge
 */
import { appendFileSync } from 'node:fs'
import { resolveConfig } from './src/config.js'
import { registerPromptSection } from './src/prompt.js'
import { runSelfCheck } from './src/self-check.js'
import { createShellPool } from './src/shell.js'
import { buildTools } from './src/tools.js'

/** Cordis plugin name (the loader row id is `wsl-bridge`, a separate namespace). */
export const name = 'dsh-wsl-bridge'

/** Required services: tool registry, subprocess seam and prompt registry. */
export const inject = ['tools', 'subprocess', 'systemPrompt']

/**
 * Mount the bridge.
 *
 * @param {object} ctx - cordis context carrying tools/subprocess/systemPrompt.
 * @param {object} [rawConfig] - the loader row's `config` block.
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = resolveConfig(rawConfig)
  } catch (error) {
    // A bad config is an operator error, not an absence: report and keep booting.
    ctx.logger?.error?.('dsh-wsl-bridge: ' + messageOf(error))
    return
  }
  if (process.platform !== 'win32') {
    ctx.logger?.info?.('dsh-wsl-bridge: not mounted (host platform is ' + process.platform + ')')
    return
  }

  // `spawn` is the only subprocess entry the pool needs; binding through a
  // closure keeps the seam replaceable in tests.
  // Capture the service object instead of the context: hosts may deactivate a
  // mount context after apply() returns (preset activation does), and a late
  // `ctx.subprocess` lookup would then throw "inactive context".
  const subprocess = ctx.subprocess
  const jobs = readService(ctx, 'jobs')
  const pool = createShellPool({
    spawn: (options) => subprocess.spawn(options),
    config,
    logger: ctx.logger,
  })

  // One shell per agent; dispose it when the agent goes away or the row unloads.
  ctx.effect(() => () => pool.disposeAll(), 'dsh-wsl-bridge: shell pool')
  ctx.on('agent/disposed', ({ agent }) => {
    pool.dispose(agent, 'agent disposed')
  })

  const tools = buildTools({ pool, config, subprocess, jobs })
  for (const tool of tools) {
    ctx.effect(() => {
      const unregister = ctx.tools.register(tool)
      return () => unregister()
    }, 'dsh-wsl-bridge: ' + tool.name)
  }

  if (config.promptSection) {
    try {
      registerPromptSection(ctx, config)
    } catch (error) {
      // A prompt contribution is an enhancement; never take the mount down for it.
      ctx.logger?.warn?.('dsh-wsl-bridge: prompt section skipped: ' + messageOf(error))
    }
  }

  ctx.logger?.info?.(
    'dsh-wsl-bridge: mounted distro=' + (config.distro === '' ? '(default)' : config.distro)
    + ' tools=' + tools.map((tool) => tool.name).join(','),
  )
  // Unconditional mount record when a marker path is configured: integration
  // tests read it even when the WSL self-check itself cannot run.
  if (config.selfCheckMarker !== '') {
    try {
      appendFileSync(config.selfCheckMarker, '[dsh-wsl-bridge] mount ' + new Date().toISOString()
        + ' distro=' + (config.distro === '' ? '(default)' : config.distro)
        + ' promptSection=' + String(config.promptSection) + ' selfCheck=' + String(config.selfCheck)
        + ' jobs=' + String(jobs !== undefined) + '\n')
    } catch {
      // diagnostic only
    }
  }

  if (config.selfCheck) {
    // Integration-test hook: prove that the HOST process can reach wsl.exe and
    // that the persistent shell keeps `cd` across calls. Never awaited: a slow
    // distribution start must not delay the mount.
    void runSelfCheck(ctx, pool, config, tools, { subprocess, jobs })
  }
}

/**
 * Human-readable message for an unknown thrown value.
 * @param {unknown} error
 * @returns {string}
 */
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
