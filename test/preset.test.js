// DSH 0.2.2 removed the separate list-agents entry and renamed model options.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

assert.doesNotMatch(patch, /@deepseek-ai\/dsh-tool-subagent-control\/list-agents/u)
assert.match(patch, /name: '@deepseek-ai\/dsh-tool-subagent-control'/u)
console.log('ok   preset: subagent control uses the current package entry')

const subagent = patch.match(/ {14}- id: tool-subagent\r?\n([\s\S]*?)(?=\r?\n {14}- id:)/u)?.[1]
assert.equal(typeof subagent, 'string')
assert.match(subagent, /modelSelection: true/u)
assert.match(subagent, /modelDiscovery: true/u)
assert.doesNotMatch(patch, /modelSelectionSettings/u)
console.log('ok   preset: spawned subagents use the current model options')

assert.equal(pkg.engines.dsh, '>=0.2.2-rc.1')
assert.equal(pkg.dsh.engines.dsh, pkg.engines.dsh)
assert.equal(pkg.peerDependencies['@deepseek-ai/dsh'], pkg.engines.dsh)
console.log('ok   preset: all compatibility gates require the supported DSH version')

console.log('3 preset checks passed')
