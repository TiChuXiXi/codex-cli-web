import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { WeChatChannel } from '../server/channels/wechat/channel.js'
import { RouterStore } from '../server/router/store.js'

test('a WAL backup preserves Worker identity, uncertain commands and an encrypted paused binding across two opens', async t => {
  const root = await mkdtemp(join(tmpdir(), 'uas-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'copy')
  await mkdir(target)
  const source = new RouterStore(join(root, 'router.sqlite'))
  const account = { paused: 'paused', generation: 'fixture', token: 'fixture-only', cursor: 'cursor-7' }
  const filename = join(target, 'router.sqlite')
  try {
    new WeChatChannel({ store: source, directory: root }).saveAccount(account)
    source.put('task', 'd1', { id: 'd1', threadId: 'original-worker', status: 'unknown' })
    source.put('dispatch-key', 'request-1', { id: 'd1', fingerprint: 'original' })
    // Reconstruct the v3 fixture before the v4 command table existed.
    source.db.exec('DROP TABLE router_commands; PRAGMA user_version=3')
    await backup(source.db, join(root, 'preflight.sqlite'))
    await copyFile(join(root, 'preflight.sqlite'), filename)
    await copyFile(join(root, 'wechat.key'), join(target, 'wechat.key'))
    for (let pass = 0; pass < 2; pass++) {
      const store = new RouterStore(filename)
      try {
        assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
        assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4)
        assert.equal(store.get('task', 'd1').threadId, 'original-worker')
        assert.equal(store.get('dispatch-key', 'request-1').id, 'd1')
        assert.equal(store.command('d1').state, 'unknown')
        assert.equal(store.db.prepare('SELECT count(*) AS n FROM router_commands').get().n, 1)
        const channel = new WeChatChannel({ store, directory: target })
        assert.deepEqual(channel.account, account)
        assert.equal(channel.phase, 'paused')
      } finally { store.close() }
    }
    // No external work was admitted. Restore the original snapshot on this copy only.
    await copyFile(join(root, 'preflight.sqlite'), filename)
    const restored = new DatabaseSync(filename, { readOnly: true })
    try {
      assert.equal(restored.prepare('PRAGMA user_version').get().user_version, 3)
      assert.equal(restored.prepare('SELECT count(*) AS n FROM wechat_records').get().n, 1)
      assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    } finally { restored.close() }
  } finally { source.close() }
})
