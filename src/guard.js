/**
 * Deterministic destructive-command guard.
 *
 * The bridge runs `wsl.exe` through the host subprocess seam, below DSH's file
 * sandbox, so a WSL write cannot be fenced by the Windows ACL policy. This check
 * is the honest substitute: a fixed refusal list that stops the obvious
 * irreversible commands unless the call explicitly passes `allowDangerous: true`.
 *
 * It is an advisory guard, not a security boundary: a determined command can
 * spell the same effect differently. Documented as such in README/SECURITY.
 *
 * @module dsh-wsl-bridge/guard
 */

/** Wrappers whose own argv sits in front of the real command. */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'timeout', 'nice', 'ionice', 'nohup', 'xargs'])

/** Tools that repartition or wipe block devices. */
const DEVICE_TOOLS = new Set(['fdisk', 'parted', 'wipefs', 'mkswap', 'mke2fs', 'sfdisk', 'cgdisk', 'gdisk'])

/** Power-state tools that take the machine (or the distribution) down. */
const POWER_TOOLS = new Set(['shutdown', 'reboot', 'poweroff', 'halt', 'init'])

/**
 * Check one model-issued command.
 *
 * @param {string} command - the exact bash command that would run.
 * @returns {string|null} a short refusal reason, or null when the command is fine.
 */
export function checkDangerous(command) {
  const text = String(command)
  if (/:\(\)\s*\{/u.test(text)) return 'looks like a fork bomb'
  for (const segment of text.split(/\n|;|&&|\|\||\|/u)) {
    const reason = checkSegment(segment)
    if (reason !== null) return reason
  }
  return null
}

/**
 * Check one command segment (already split on control operators and pipes).
 *
 * @param {string} segment
 * @returns {string|null}
 */
function checkSegment(segment) {
  const tokens = segment.trim().split(/\s+/u).filter((token) => token !== '')
  if (tokens.length === 0) return null
  const { name, args } = baseCommand(tokens)
  if (name === '') return null

  if (name === 'rm') {
    const recursive = args.some((arg) => arg === '--recursive' || (arg.startsWith('-') && arg.includes('r'))
      || (arg.startsWith('-') && arg.includes('R')))
    if (recursive) return 'recursive delete (rm -r) needs allowDangerous: true'
  }
  if (name === 'find' && args.includes('-delete')) {
    return 'find -delete needs allowDangerous: true'
  }
  if (name === 'dd' && args.some((arg) => arg.startsWith('of=/dev/'))) {
    return 'dd onto a block device needs allowDangerous: true'
  }
  if (name === 'truncate' && args.some((arg) => arg.startsWith('/dev/'))) {
    return 'truncate onto a device needs allowDangerous: true'
  }
  if (/^mkfs/u.test(name) || DEVICE_TOOLS.has(name)) {
    return 'formatting/partitioning a device needs allowDangerous: true'
  }
  if (POWER_TOOLS.has(name)) {
    return 'power control (' + name + ') needs allowDangerous: true'
  }
  if (name === 'systemctl' && args.some((arg) => ['reboot', 'poweroff', 'halt', 'kexec'].includes(arg))) {
    return 'systemctl power control needs allowDangerous: true'
  }
  if (name === 'git' && args[0] === 'clean' && args.some((arg) => /^-[a-zA-Z]*[fdx]/u.test(arg))) {
    return 'git clean -f/-d/-x removes files and needs allowDangerous: true'
  }
  return null
}

/**
 * Strip leading env assignments and wrappers to find the command actually run.
 *
 * @param {string[]} tokens
 * @returns {{name: string, args: string[]}}
 */
function baseCommand(tokens) {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      index += 1
      continue
    }
    if (WRAPPERS.has(token)) {
      index += 1
      // Skip wrapper flags, and the simple option values they take.
      while (index < tokens.length) {
        const next = tokens[index]
        if (next === '-u' || next === '-g' || next === '-n' || next === '-p' || next === '-C' || next === '--user') {
          index += 2
          continue
        }
        if (next.startsWith('-')) {
          index += 1
          continue
        }
        break
      }
      continue
    }
    return { name: token, args: tokens.slice(index + 1) }
  }
  return { name: '', args: [] }
}
