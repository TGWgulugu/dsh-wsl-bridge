/**
 * Decide when the WSL folder picker should open, and open the folder the
 * user picked. The browser entry cannot import this file.
 *
 * @module dsh-wsl-bridge/client-workspace
 */

/**
 * A workspace already lives inside a distribution when its Windows path is
 * `\\wsl.localhost\...` or `\\wsl$\...`. Drive letters are Windows folders.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDistributionWorkspacePath(value) {
  return /^\\\\wsl(?:\.localhost|\$)\\/iu.test(normalize(value))
}

/**
 * Offer the picker when this session is in WSL mode and its folder is still
 * a Windows directory, including DSH's first-use `default-workspace`.
 *
 * @param {unknown} preset
 * @param {unknown} cwd
 * @returns {boolean}
 */
export function shouldOfferFolderPicker(preset, cwd) {
  return preset === 'wsl' && !isDistributionWorkspacePath(cwd)
}

/**
 * Decide whether this snapshot should open the folder picker.
 *
 * `shown` means this visit to WSL mode already opened the window. Leaving
 * WSL mode records `other`, so choosing WSL again asks one more time.
 * Esc does not lock the session permanently.
 *
 * @param {string|undefined} previous
 * @param {string} preset
 * @param {unknown} cwd
 * @returns {{state: string, open: boolean}}
 */
export function nextPickerState(previous, preset, cwd) {
  if (preset !== 'wsl') return { state: 'other', open: false }
  if (!shouldOfferFolderPicker(preset, cwd)) return { state: 'wsl', open: false }
  if (previous === 'shown' || previous === 'wsl') return { state: previous, open: false }
  return { state: 'shown', open: true }
}

/**
 * @param {object|undefined} summary
 * @param {object|undefined} projections
 * @returns {string}
 */
export function presetOf(summary, projections) {
  const values = summary?.projectionValues ?? projections?.values
  const preset = values?.agentPreset
  return typeof preset === 'string' ? preset : ''
}

/**
 * @param {Record<string, {id?: string, retainedBy?: {mainView?: number}}>|undefined} byId
 * @returns {string|undefined}
 */
export function mainViewSessionId(byId) {
  if (byId === undefined || byId === null) return undefined
  for (const row of Object.values(byId)) {
    if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) {
      return typeof row.id === 'string' ? row.id : undefined
    }
  }
  return undefined
}

/**
 * @param {object|undefined} created
 * @returns {string|undefined}
 */
export function workspaceIdFromCreate(created) {
  const workspace = created?.workspace ?? created?.value?.workspace ?? created
  return typeof workspace?.workspaceId === 'string' ? workspace.workspaceId : undefined
}

/**
 * Register the picked Windows path and open it as a WSL session.
 * The path is whatever `wslpath -w` printed for the folder the user chose.
 *
 * @param {object} workspaces
 * @param {object} ui
 * @param {string} windowsPath
 * @returns {Promise<string>}
 */
export async function openChosenWorkspace(workspaces, ui, windowsPath) {
  if (typeof windowsPath !== 'string' || windowsPath === '') throw new Error('WSL folder is missing')
  if (typeof workspaces?.create !== 'function' || typeof ui?.openWorkspace !== 'function') {
    throw new Error('workspace services are unavailable')
  }
  const created = await workspaces.create({ path: windowsPath })
  const id = workspaceIdFromCreate(created)
  if (id === undefined) throw new Error('WSL workspace was not created')
  await ui.openWorkspace(id, undefined, { agentPreset: 'wsl' })
  return id
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalize(value) {
  return String(value ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '')
}
