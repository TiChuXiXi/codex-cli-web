import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { saveUploadStream } from '../server/services/uploads.js'
import { MAX_UPLOAD_BYTES } from '../shared/limits.js'
import { createRoutes } from '../server/api/routes.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-stream-upload-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function files(root) {
  return readdir(join(root, '.dsh-uploads', 'codex-cli')).catch(() => [])
}
test('500 MiB raw HTTP upload streams to disk and preserves every byte', async t => {
  const root = await fixture(t)
  const handler = createRoutes({ connection: { requestRejection: () => undefined }, config: { maxBodyBytes: 4096 } })
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { handler.dispose(); await new Promise(resolve => server.close(resolve)) })
  const chunk = Buffer.alloc(1024 * 1024, 0xa5)
  chunk.write('MZ')
  const expected = createHash('sha256')
  async function* body() {
    for (let i = 0; i < 500; i++) { expected.update(chunk); yield chunk }
  }
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/codex-cli/upload/file?' + new URLSearchParams({ cwd: root, name: 'installer.exe', size: String(MAX_UPLOAD_BYTES) }), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, duplex: 'half', body: Readable.from(body()),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.ok, true)
  assert.equal(result.value.size, MAX_UPLOAD_BYTES)
  assert.equal((await stat(result.value.path)).size, MAX_UPLOAD_BYTES)
  const actual = createHash('sha256')
  for await (const data of createReadStream(result.value.path)) actual.update(data)
  assert.equal(actual.digest('hex'), expected.digest('hex'))
  assert.equal((await files(root)).length, 1)
})

test('partial, oversized, aborted and failed streams leave no temporary files', async t => {
  const root = await fixture(t)
  const data = Buffer.from('MZ fixture')
  const save = (size, stream, signal) => saveUploadStream({ cwd: root, name: 'test.exe', size, stream, signal })
  await assert.rejects(save(MAX_UPLOAD_BYTES + 1, Readable.from([data])), { code: 'codex-cli/file-too-large' })
  await assert.rejects(save(data.length + 1, Readable.from([data])), { code: 'codex-cli/upload-incomplete' })
  await assert.rejects(save(1, Readable.from([data])), { code: 'codex-cli/file-too-large' })
  await assert.rejects(save(0, Readable.from([])), { code: 'codex-cli/bad-request' })
  await assert.rejects(save(data.length, Readable.from((async function* () { yield data.subarray(0, 1); throw Error('fixture disconnect') })())), /fixture disconnect/)
  const controller = new AbortController()
  await assert.rejects(save(data.length, Readable.from((async function* () { yield data.subarray(0, 1); controller.abort(); yield data.subarray(1) })()), controller.signal), { name: 'AbortError' })
  assert.deepEqual(await files(root), [])
  const results = await Promise.all([save(data.length, Readable.from([data])), save(data.length, Readable.from([data]))])
  assert.notEqual(results[0].path, results[1].path)
  assert.equal((await files(root)).length, 2)
})

test('raw upload rejects escaped directories and shares authentication and request validation', async t => {
  const root = await fixture(t), outside = await fixture(t)
  await mkdir(join(root, '.dsh-uploads'))
  await symlink(outside, join(root, '.dsh-uploads', 'codex-cli'))
  await assert.rejects(saveUploadStream({ cwd: root, name: 'test.exe', size: 2, stream: Readable.from(['MZ']) }), /超出工作区/)
  assert.deepEqual(await readdir(outside), [])
  let rejection = 401
  const handler = createRoutes({ connection: { requestRejection: () => rejection }, config: { maxBodyBytes: 4096 } })
  const server = createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { handler.dispose(); await new Promise(resolve => server.close(resolve)) })
  const url = size => 'http://127.0.0.1:' + server.address().port + '/codex-cli/upload/file?' + new URLSearchParams({ cwd: outside, name: 'test.exe', size: String(size) })
  const send = (size, type = 'application/octet-stream') => fetch(url(size), { method: 'POST', headers: { 'content-type': type }, body: 'MZ' })
  assert.equal((await send(2)).status, 401)
  rejection = undefined
  assert.equal((await send(2, 'application/json')).status, 415)
  assert.equal((await send(3)).status, 400)
  // Declared limit is checked before any body is accepted (no content-length header).
  const oversized = await fetch(url(MAX_UPLOAD_BYTES + 1), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, duplex: 'half', body: Readable.from(['MZ']) })
  assert.equal(oversized.status, 413)
  assert.deepEqual(await readdir(outside), [])
})
