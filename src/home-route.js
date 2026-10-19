/**
 * Tell the desktop page which directory `wslpath -w "$HOME"` returned.
 * The path is computed on the host that is running the plugin. The route
 * answers only on loopback.
 *
 * @module dsh-wsl-bridge/home-route
 */

export const HOME_ROUTE_PATH = '/api/dsh-wsl-bridge/home'

/**
 * @param {object} ctx
 * @param {() => Promise<string>} homeWindows
 */
export function registerHomeRoute(ctx, homeWindows) {
  const webServer = readService(ctx, 'webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') return
  ctx.effect(() => webServer.register(homeRoute(homeWindows)), 'dsh-wsl-bridge: home route')
}

/**
 * @param {() => Promise<string>} homeWindows
 * @returns {{kind: string, path: string, handler: Function}}
 */
export function homeRoute(homeWindows) {
  return {
    kind: 'exact',
    path: HOME_ROUTE_PATH,
    handler(req, res) {
      if (!isLoopback(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      if (req?.method !== 'GET') {
        writeJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      Promise.resolve(homeWindows()).then(
        (path) => writeJson(res, 200, { path }),
        (error) => writeJson(res, 503, { error: messageOf(error) }),
      )
    },
  }
}

/**
 * @param {object|undefined} req
 * @returns {boolean}
 */
export function isLoopback(req) {
  const address = String(req?.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
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
