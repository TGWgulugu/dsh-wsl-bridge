import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { editText, readText } from '../src/fsops.js'

const hash = (text) => createHash('sha256').update(text).digest('hex')
let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log('ok   ' + name)
}

await test('edit: replacement dollar sequences stay literal', async () => {
  const original = 'prefix OLD suffix'
  const replacement = "$& $$ $` $'"
  const pool = { async runOnce(req) {
    if (req.input === undefined) return { stdout: Buffer.from(original).toString('base64'), stderr: '', exitCode: 0 }
    assert.equal(Buffer.from(req.input, 'base64').toString(), 'prefix ' + replacement + ' suffix')
    return { stdout: hash('updated'), stderr: '', exitCode: 0 }
  } }
  assert.equal((await editText(pool, { path: '/file', oldString: 'OLD', newString: replacement })).ok, true)
})

await test('edit: fence uses bytes read even when the file changes before hashing', async () => {
  const pool = { async runOnce(req) {
    if (req.input === undefined) return { stdout: Buffer.from('original').toString('base64'), stderr: '', exitCode: 0 }
    assert.ok(req.command.includes(hash('original')))
    return { stdout: hash('concurrent change'), stderr: '', exitCode: 73 }
  } }
  const result = await editText(pool, { path: '/file', oldString: 'original', newString: 'edited' })
  assert.equal(result.code, 'stale')
})

await test('edit: invalid UTF-8 cannot silently corrupt other bytes', async () => {
  const pool = { async runOnce(req) {
    assert.equal(req.input, undefined, 'must never write invalid UTF-8')
    return { stdout: Buffer.from([65, 255]).toString('base64'), stderr: '', exitCode: 0 }
  } }
  await assert.rejects(() => editText(pool, { path: '/file', oldString: 'A', newString: 'B' }), /not valid UTF-8/)
})

await test('read: incomplete transport is rejected instead of decoded as a complete file', async () => {
  const pool = { async runOnce() {
    return { stdout: Buffer.from('tail').toString('base64'), stderr: '', exitCode: 0, truncated: true }
  } }
  await assert.rejects(() => readText(pool, { path: '/file' }), /transport was truncated/)
})

console.log('\n' + passed + ' passed, 0 failed')
