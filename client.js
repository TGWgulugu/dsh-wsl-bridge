window.__ModuleLoader__.load({
  id: 'dsh-wsl-bridge',
  factory: (require) => {
    const DIRS_ROUTE_PATH = '/api/dsh-wsl-bridge/dirs'

    function apply(ctx) {
      let React
      try {
        React = require('react')
      } catch (error) {
        ctx.logger?.warn?.('dsh-wsl-bridge: folder picker skipped: ' + messageOf(error))
        return
      }
      const sessions = readService(ctx, 'sessions')
      const workspaces = readService(ctx, 'workspaces')
      const ui = readService(ctx, 'uiWorkspace')
      const slots = readService(ctx, 'slots')
      if (sessions?.list?.subscribe === undefined || typeof workspaces?.create !== 'function'
        || typeof ui?.openWorkspace !== 'function' || typeof slots?.inject !== 'function') {
        ctx.logger?.info?.('dsh-wsl-bridge: folder picker left inactive')
        return
      }
      const store = createPickerStore()
      const pickerState = new Map()
      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'dsh-wsl-bridge-folder',
        order: 40,
      }, () => React.createElement(FolderPicker, { React, store, workspaces, ui })))
      const sync = () => {
        const sessionList = sessions.list.getSnapshot()
        if (sessionList?.phase !== 'ready') return
        const sessionId = mainViewSessionId(sessionList.byId)
        if (sessionId === undefined) return
        const summary = sessionList.byId?.[sessionId]
        const preset = presetOf(summary, sessionList.projectionsBySession?.[sessionId])
        const decision = nextPickerState(pickerState.get(sessionId), preset, summary?.cwd)
        pickerState.set(sessionId, decision.state)
        if (decision.open && !store.isOpen()) store.open()
      }
      ctx.effect(() => sessions.list.subscribe(sync))
      sync()
    }

    function FolderPicker({ React, store, workspaces, ui }) {
      const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      React.useEffect(() => {
        if (!snap.open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') store.dismiss()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [snap.open, store])
      if (!snap.open) return null
      const h = React.createElement
      const listing = snap.listing
      return h('div', { style: backdropStyle },
        h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-wsl-bridge-title',
          style: panelStyle,
        },
        h('h2', { id: 'dsh-wsl-bridge-title', style: titleStyle }, '选择 WSL 工作区'),
        h('p', { style: hintStyle }, '从当前发行版里选一个文件夹。右上角的文件夹按钮会打开这里，不再打开 default-workspace。'),
        h('div', { style: pathStyle }, listing?.path ?? '正在读取目录…'),
        snap.error === '' ? null : h('p', { style: errorStyle }, snap.error),
        h('div', { style: listStyle },
          listing?.parent ? h('button', {
            type: 'button',
            style: rowStyle,
            onClick: () => store.load(listing.parent.path),
          }, '上一级') : null,
          ...(listing?.entries ?? []).map((entry) => h('button', {
            key: entry.path,
            type: 'button',
            style: rowStyle,
            onClick: () => store.load(entry.path),
          }, entry.name + '/')),
          listing && listing.entries.length === 0
            ? h('p', { style: hintStyle }, '没有子文件夹，可以直接使用当前目录。')
            : null,
        ),
        h('div', { style: actionStyle },
          h('button', { type: 'button', style: secondaryStyle, onClick: () => store.dismiss() }, '取消'),
          h('button', {
            type: 'button',
            style: primaryStyle,
            disabled: listing?.windows === undefined || snap.creating,
            onClick: () => store.confirm(workspaces, ui),
          }, snap.creating ? '正在创建…' : '使用此文件夹'),
        ),
        ),
      )
    }

    function createPickerStore() {
      let snap = { open: false, listing: null, error: '', creating: false }
      let loadTicket = 0
      const listeners = new Set()
      const publish = (next) => {
        snap = next
        for (const listener of listeners) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          return snap
        },
        isOpen() {
          return snap.open
        },
        open() {
          publish({ open: true, listing: null, error: '', creating: false })
          void this.load('')
        },
        dismiss() {
          publish({ open: false, listing: null, error: '', creating: false })
        },
        async load(linuxPath) {
          const ticket = ++loadTicket
          publish({ ...snap, error: '', creating: false })
          try {
            const listing = await readDirectory(linuxPath)
            if (!snap.open || ticket !== loadTicket) return
            publish({ open: true, listing, error: '', creating: false })
          } catch (error) {
            if (!snap.open || ticket !== loadTicket) return
            publish({ ...snap, error: '读不到这个目录：' + messageOf(error), creating: false })
          }
        },
        async confirm(workspaces, ui) {
          const windowsPath = snap.listing?.windows
          if (typeof windowsPath !== 'string' || snap.creating) return
          publish({ ...snap, creating: true, error: '' })
          try {
            await openChosenWorkspace(workspaces, ui, windowsPath)
            publish({ open: false, listing: null, error: '', creating: false })
          } catch (error) {
            publish({ ...snap, creating: false, error: '没能创建工作区：' + messageOf(error) })
          }
        },
      }
    }

    async function readDirectory(linuxPath) {
      const url = linuxPath === undefined || linuxPath === ''
        ? DIRS_ROUTE_PATH
        : DIRS_ROUTE_PATH + '?path=' + encodeURIComponent(linuxPath)
      const response = await fetch(url)
      const body = await response.json().catch(() => null)
      if (!response.ok || typeof body?.path !== 'string' || typeof body?.windows !== 'string') {
        throw new Error(typeof body?.error === 'string' ? body.error : 'HTTP ' + response.status)
      }
      return body
    }

    async function openChosenWorkspace(workspaces, ui, windowsPath) {
      const created = await workspaces.create({ path: windowsPath })
      const workspace = created?.workspace ?? created?.value?.workspace ?? created
      const id = typeof workspace?.workspaceId === 'string' ? workspace.workspaceId : ''
      if (id === '') throw new Error('WSL workspace was not created')
      await ui.openWorkspace(id, undefined, { agentPreset: 'wsl' })
    }

    function shouldOfferFolderPicker(preset, cwd) {
      return preset === 'wsl' && !isDistributionWorkspacePath(cwd)
    }

    function nextPickerState(previous, preset, cwd) {
      if (preset !== 'wsl') return { state: 'other', open: false }
      if (!shouldOfferFolderPicker(preset, cwd)) return { state: 'wsl', open: false }
      if (previous === 'shown' || previous === 'wsl') return { state: previous, open: false }
      return { state: 'shown', open: true }
    }

    function isDistributionWorkspacePath(value) {
      return /^\\\\wsl(?:\.localhost|\$)\\/iu.test(normalize(value))
    }

    function presetOf(summary, projections) {
      const values = summary?.projectionValues ?? projections?.values
      const preset = values?.agentPreset
      return typeof preset === 'string' ? preset : ''
    }

    function mainViewSessionId(byId) {
      if (byId === undefined || byId === null) return undefined
      for (const row of Object.values(byId)) {
        if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) {
          return typeof row.id === 'string' ? row.id : undefined
        }
      }
      return undefined
    }

    function normalize(value) {
      return String(value ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '')
    }

    function readService(ctx, name) {
      try {
        if (ctx?.[name] !== undefined) return ctx[name]
        return typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    const backdropStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 40,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.62)',
      padding: 24,
    }
    const panelStyle = {
      width: 'min(520px, 100%)',
      maxHeight: 'min(640px, 100%)',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      padding: 20,
      borderRadius: 12,
      backgroundColor: 'Canvas',
      color: 'CanvasText',
      border: '1px solid color-mix(in srgb, CanvasText 18%, Canvas)',
      boxShadow: '0 18px 50px rgba(0, 0, 0, 0.35)',
      boxSizing: 'border-box',
    }
    const titleStyle = { margin: 0, fontSize: 18, fontWeight: 600 }
    const hintStyle = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'color-mix(in srgb, CanvasText 78%, Canvas)' }
    const pathStyle = {
      fontFamily: 'ui-monospace, monospace',
      fontSize: 13,
      padding: '8px 10px',
      borderRadius: 8,
      backgroundColor: 'color-mix(in srgb, CanvasText 8%, Canvas)',
      color: 'CanvasText',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const errorStyle = { margin: 0, fontSize: 13, color: '#b42318' }
    const listStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      minHeight: 160,
      maxHeight: 320,
      overflow: 'auto',
    }
    const rowStyle = {
      textAlign: 'left',
      border: '1px solid color-mix(in srgb, CanvasText 16%, Canvas)',
      backgroundColor: 'color-mix(in srgb, CanvasText 6%, Canvas)',
      color: 'CanvasText',
      borderRadius: 8,
      padding: '8px 10px',
      cursor: 'pointer',
      font: 'inherit',
    }
    const actionStyle = { display: 'flex', justifyContent: 'flex-end', gap: 8 }
    const secondaryStyle = {
      font: 'inherit',
      padding: '8px 14px',
      borderRadius: 8,
      border: '1px solid color-mix(in srgb, CanvasText 22%, Canvas)',
      backgroundColor: 'Canvas',
      color: 'CanvasText',
      cursor: 'pointer',
    }
    const primaryStyle = {
      font: 'inherit',
      padding: '8px 14px',
      borderRadius: 8,
      border: 0,
      backgroundColor: '#247bbf',
      color: '#fff',
      cursor: 'pointer',
    }

    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace'],
      apply,
    }
  },
})
