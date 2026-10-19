/**
 * The folder picker opens for a WSL session that is still on a Windows folder.
 * Run: node test/client-workspace.test.js
 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import {
  mainViewSessionId, nextPickerState, openChosenWorkspace, presetOf, shouldOfferFolderPicker,
} from '../src/client-workspace.js'

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    failures.push(name + ': ' + (error instanceof Error ? error.stack : String(error)))
    console.log('FAIL ' + name)
  }
}

const defaults = 'C:\\Users\\someone\\Documents\\deepseek-harness\\default-workspace'
const home = '\\\\wsl$\\Debian\\root'

await test('browser entry: classic script, no export keyword', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  new vm.Script(source)
  assert.equal(source.includes('export '), false)
  assert.match(source, /__ModuleLoader__/)
  assert.match(source, /id: 'dsh-wsl-bridge'/)
  assert.match(source, /inject: \['slots', 'sessions', 'workspaces', 'uiWorkspace'\]/)
  assert.match(source, /选择 WSL 工作区/)
  assert.match(source, /backgroundColor: 'Canvas'/)
  assert.equal(source.includes('--dsw-alias-bg-base'), false)
})

await test('picker: a WSL session on a Windows folder asks, a distribution folder does not', () => {
  assert.equal(shouldOfferFolderPicker('wsl', defaults), true)
  assert.equal(shouldOfferFolderPicker('wsl', 'D:/deepseek-harness/default-workspace/'), true)
  assert.equal(shouldOfferFolderPicker('wsl', home), false)
  assert.equal(shouldOfferFolderPicker('wsl', '//wsl.localhost/Ubuntu/home/someone'), false)
  assert.equal(shouldOfferFolderPicker('standard', defaults), false)
  const byId = {
    other: { id: 'other', retainedBy: { mainView: 0 } },
    main: { id: 'main', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'wsl' }, cwd: defaults },
  }
  assert.equal(mainViewSessionId(byId), 'main')
  assert.equal(presetOf(byId.main), 'wsl')
})

await test('picker: Esc closes this visit, and choosing WSL again asks once more', () => {
  const windows = 'D:\\deepseek-harness\\default-workspace'
  const first = nextPickerState(undefined, 'wsl', windows)
  assert.equal(first.open, true)
  const dismissed = nextPickerState(first.state, 'wsl', windows)
  assert.equal(dismissed.open, false)
  const left = nextPickerState(dismissed.state, 'standard', windows)
  assert.equal(left.open, false)
  const again = nextPickerState(left.state, 'wsl', windows)
  assert.equal(again.open, true)
  assert.equal(nextPickerState(again.state, 'wsl', home).open, false)
})

await test('picker: the chosen windows path is created and opened', async () => {
  const created = []
  const opened = []
  const id = await openChosenWorkspace(
    {
      create: async (input) => {
        created.push(input.path)
        return { workspace: { workspaceId: 'created' } }
      },
    },
    { openWorkspace: async (...args) => { opened.push(args) } },
    home,
  )
  assert.equal(id, 'created')
  assert.deepEqual(created, [home])
  assert.equal(opened[0][0], 'created')
  assert.deepEqual(opened[0][2], { agentPreset: 'wsl' })
})

if (failed > 0) {
  console.error(failures.join('\n\n'))
  process.exit(1)
}
console.log(passed + ' passed')
