/**
 * Minimal fake cordis context for unit tests: just the services apply() touches.
 * Deliberately not a cordis implementation — enough to mount the plugin and call
 * its tools without a host process.
 *
 * @module test/fake-ctx
 */
import { appendFileSync } from 'node:fs'

/**
 * Create a fake context.
 * @param {{logFile?: string}} [options]
 */
export function createFakeContext(options = {}) {
  /** @type {Map<string, object>} */
  const tools = new Map()
  /** @type {Map<string, object>} */
  const sections = new Map()
  /** @type {string[]} */
  const log = []
  /** @type {Array<() => void>} */
  const effects = []

  const ctx = {
    logger: {
      info: (message) => record('info', message),
      warn: (message) => record('warn', message),
      error: (message) => record('error', message),
    },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) {
          throw new Error('tool "' + definition.name + '" is already registered in this scope')
        }
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    subprocess: {
      spawn() {
        throw new Error('fake context: ctx.subprocess.spawn was called without a fake pool')
      },
    },
    systemPrompt: {
      section(entry) {
        sections.set(entry.name, entry)
        return () => sections.delete(entry.name)
      },
    },
    effect(fn) {
      effects.push(fn())
    },
    on() {},
  }

  /** @param {string} level @param {string} message */
  function record(level, message) {
    const line = level + ' ' + String(message)
    log.push(line)
    if (options.logFile !== undefined) {
      try {
        appendFileSync(options.logFile, line + '\n')
      } catch {
        // diagnostic only
      }
    }
  }

  return {
    ctx,
    tools,
    sections,
    log,
    /** Run every registered effect cleanup, like a plugin unload. */
    dispose() {
      for (const cleanup of effects.splice(0)) {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
}
