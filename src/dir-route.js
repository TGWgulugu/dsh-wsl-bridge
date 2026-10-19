/**
 * List one WSL directory for the folder picker.
 * Answers only on loopback. An omitted path starts at `$HOME`.
 *
 * @module dsh-wsl-bridge/dir-route
 */
import { directoryListCommand, isListedLinuxPath, parseDirectoryListing } from './dir-list.js'
import { isLoopback } from './home-route.js'

export const DIRS_ROUTE_PATH = '/api/dsh-wsl-bridge/dirs'

/**
 * @param {object} ctx
 * @param {object} pool
 * @param {object} config
 */
export function registerDirRoute(ctx, pool, config) {
  const webServer = readService(ctx, 'webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') return
  ctx.effect(() => webServer.register(dirRoute(pool, config)), 'dsh-wsl-bridge: directory route')
}

/**
 * @param {object} pool
 * @param {object} config
 * @returns {{kind: string, path: string, handler: Function}}
 */
export function dirRoute(pool, config) {
  return {
    kind: 'prefix',
    path: DIRS_ROUTE_PATH,
    async handler(req, res) {
      try {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden' })
          return
        }
        if (req?.method !== 'GET') {
          writeJson(res, 405, { error: 'method-not-allowed' })
          return
        }
        const url = new URL(req?.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== DIRS_ROUTE_PATH) {
          writeJson(res, 404, { error: 'not-found' })
          return
        }
        const requested = url.searchParams.get('path') ?? ''
        if (requested !== '' && !isListedLinuxPath(requested)) {
          writeJson(res, 400, { error: 'path rejected' })
          return
        }
        const result = await pool.runOnce({
          command: directoryListCommand(requested),
          timeoutMs: config?.fileTimeoutMs,
        })
        const listing = result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true
          ? parseDirectoryListing(result.stdout)
          : null
        if (listing === null) {
          const detail = String(result?.stderr ?? '').trim()
          writeJson(res, 503, { error: detail === '' ? 'could not list the WSL directory' : detail })
          return
        }
        writeJson(res, 200, listing)
      } catch (error) {
        if (res.headersSent) return
        writeJson(res, 503, { error: messageOf(error) })
      }
    },
  }
}

/**
 * @param {object} res
 * @param {number} status
 * @param {object} body
 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * @param {object} ctx
 * @param {string} name
 * @returns {object|undefined}
 */
function readService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
