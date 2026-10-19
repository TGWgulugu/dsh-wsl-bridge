/**
 * Config resolution for dsh-wsl-bridge: plain defaults + hand validation.
 *
 * No schemastery here on purpose (zero-dependency constraint). Every field is
 * optional; a supplied field that violates its contract throws, and `apply()`
 * turns that into one log line instead of a failed mount.
 *
 * @module dsh-wsl-bridge/config
 */

/** @typedef {{
 *   distro: string,
 *   timeoutMs: number,
 *   fileTimeoutMs: number,
 *   selfCheckTimeoutMs: number,
 *   maxFileBytes: number,
 *   defaultWorkdir: string,
 *   promptSection: boolean,
 *   promptOrder: number,
 *   promptText: string,
 *   promptSectionName: string,
 *   selfCheck: boolean,
 *   selfCheckMarker: string,
 * }} BridgeConfig
 */

/** @type {Readonly<BridgeConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  /** WSL distribution name; empty means the system default distribution. */
  distro: '',
  /** Default deadline for `wsl_bash` calls (ms). */
  timeoutMs: 120_000,
  /** Deadline for one-shot file operations (ms). */
  fileTimeoutMs: 30_000,
  /** Deadline for the opt-in self-check command (ms). */
  selfCheckTimeoutMs: 30_000,
  /** Upper bound for `wsl_read` / `wsl_write` payloads (bytes). */
  maxFileBytes: 2 * 1024 * 1024,
  /** `session` (translate the session cwd), `home`, or an absolute Linux path. */
  defaultWorkdir: 'session',
  /** Refuse obviously destructive commands unless the call passes allowDangerous. */
  dangerGuard: true,
  /** Whether the bash tools accept runInBackground (needs the host job registry). */
  backgroundJobs: true,
  /** Publish the model-facing routing section (default ON, per user decision). */
  promptSection: true,
  /** Section sort order; external sections may use any finite order. */
  promptOrder: 3260,
  /** Override for the routing text; empty means the built-in text. */
  promptText: '',
  /** Stable section name (also the uniqueness key in the prompt registry). */
  promptSectionName: 'tool:wsl-bridge',
  /** Run the host-process WSL probe on mount (integration tests only). */
  selfCheck: false,
  /** Where the self-check record is appended; empty means log only. */
  selfCheckMarker: '',
})

/**
 * Resolve the row config.
 *
 * @param {object|undefined} input - raw row config.
 * @returns {BridgeConfig}
 * @throws {Error} when a supplied field violates its contract.
 */
export function resolveConfig(input) {
  const raw = input ?? {}
  const config = { ...DEFAULT_CONFIG }

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (raw[key] !== undefined) config[key] = raw[key]
  }

  // Integration-test hooks override the row config on purpose: the shipped row
  // pins selfCheck to false, and a harness must be able to turn the probe on
  // without editing the profile. Production rows never set these variables.
  if (process.env.DSH_WSL_BRIDGE_SELFCHECK === '1') config.selfCheck = true
  if (typeof process.env.DSH_WSL_BRIDGE_MARKER === 'string') {
    config.selfCheckMarker = process.env.DSH_WSL_BRIDGE_MARKER
  }

  if (typeof config.distro !== 'string') throw new Error('config.distro must be a string')
  if (/[\r\n]/u.test(config.distro)) throw new Error('config.distro must not contain line breaks')

  assertIntegerInRange(config, 'timeoutMs', 1_000, 24 * 60 * 60 * 1000)
  assertIntegerInRange(config, 'fileTimeoutMs', 1_000, 24 * 60 * 60 * 1000)
  assertIntegerInRange(config, 'selfCheckTimeoutMs', 1_000, 24 * 60 * 60 * 1000)
  assertIntegerInRange(config, 'maxFileBytes', 1_024, 64 * 1024 * 1024)
  assertIntegerInRange(config, 'promptOrder', -1_000_000, 1_000_000)

  if (typeof config.defaultWorkdir !== 'string') throw new Error('config.defaultWorkdir must be a string')
  if (config.defaultWorkdir !== '' && config.defaultWorkdir !== 'session'
    && config.defaultWorkdir !== 'home' && !config.defaultWorkdir.startsWith('/')) {
    throw new Error("config.defaultWorkdir must be 'session', 'home' or an absolute Linux path")
  }
  if (typeof config.dangerGuard !== 'boolean') throw new Error('config.dangerGuard must be a boolean')
  if (typeof config.backgroundJobs !== 'boolean') throw new Error('config.backgroundJobs must be a boolean')
  if (typeof config.promptSection !== 'boolean') throw new Error('config.promptSection must be a boolean')
  if (typeof config.promptText !== 'string') throw new Error('config.promptText must be a string')
  if (typeof config.promptSectionName !== 'string' || config.promptSectionName === '') {
    throw new Error('config.promptSectionName must be a non-empty string')
  }
  if (typeof config.selfCheck !== 'boolean') throw new Error('config.selfCheck must be a boolean')
  if (typeof config.selfCheckMarker !== 'string') throw new Error('config.selfCheckMarker must be a string')

  return config
}

/**
 * Validate one integer field.
 * @param {object} config
 * @param {string} key
 * @param {number} min
 * @param {number} max
 */
function assertIntegerInRange(config, key, min, max) {
  const value = config[key]
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error('config.' + key + ' must be a whole number between ' + String(min) + ' and ' + String(max))
  }
}
