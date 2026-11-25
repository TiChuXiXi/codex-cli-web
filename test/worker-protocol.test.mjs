import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runningBinaryDigest, workerProtocol } from '../server/codex/worker-protocol.js'

test('Worker protocol records bind individual capabilities to the running executable and transport', {
  skip: process.platform !== 'linux',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-protocol-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'report.json')
  const rpc = { async request(method) {
    assert.equal(method, 'server/diagnostics')
    return { process: { id: process.pid } }
  } }
  const record = { format: 1, platform: process.platform, arch: process.arch, version: '0.999.0',
    transport: 'stdio', sha256: await runningBinaryDigest(rpc), queue: true, steer: false }
  const check = (transport = 'stdio') => workerProtocol(rpc, record.version, transport, path)
  assert.equal((await check()).source, 'unverified')
  await writeFile(path, JSON.stringify({ workerProtocol: record }))
  assert.deepEqual(await check(), { queue: true, steer: false, source: 'fixture' })
  assert.equal((await check('daemon')).queue, false)
  assert.equal((await workerProtocol(rpc, '0.999.1', 'stdio', path)).queue, false)
  assert.equal((await workerProtocol({ request: async () => { throw Error('disconnect') } },
    record.version, 'stdio', path)).queue, false)
  await writeFile(path, JSON.stringify({ workerProtocol: { ...record, sha256: '0'.repeat(64) } }))
  assert.equal((await check()).source, 'unverified')
})
