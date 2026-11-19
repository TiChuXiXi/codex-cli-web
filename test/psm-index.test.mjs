import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SourceIndex } from '../server/router/psm-index.js'
import { PsmSync } from '../server/router/psm-sync.js'
import { EventBus } from '../server/services/events.js'

const turns = (body) => [
  {
    id: 'turn',
    status: 'completed',
    startedAt: 5,
    items: [
      { type: 'userMessage', id: 'msg', content: [{ type: 'text', text: body }] },
      { type: 'commandExecution', id: 'tool', aggregatedOutput: 'excludedMarker' },
    ],
  },
]
test('L1 commits text, permissions, short Chinese terms and historical edits atomically', () => {
  const db = new SourceIndex(':memory:')
  try {
    const row = { id: 'one', project: 'p', title: '优化方案', stamp: '1', state: 'active', seen: 'scan' }
    db.observe(row)
    const hits = (query, projects = ['p']) => db.search({ query, projects })
    const commit = (body) => {
      db.begin()
      db.stage(turns(body))
      db.commit(db.next())
    }
    commit('USB HUB掉线，token=secretMarker')
    assert.equal(hits('USB 掉线')[0].item, 'msg')
    assert.equal(hits('掉线', ['other']).length, 0)
    assert.equal(hits('secretMarker').length, 0)
    assert.equal(hits('excludedMarker').length, 0)
    db.mark({ id: 'one' })
    db.begin()
    db.stage(turns('新主题'))
    const stale = db.next()
    db.mark({ id: 'one', state: 'archived' })
    assert.equal(db.commit(stale), false)
    assert.equal(hits('掉线')[0].state, 'archived')
    commit('新主题')
    assert.equal(hits('掉线').length, 0)
    db.mark({ id: 'one', state: 'deleted' })
    assert.equal(hits('新主题').length, 0)
    db.observe(row)
    assert.equal(db.next(), undefined)
  } finally {
    db.close()
  }
})
test('full scan pauses between pages, reopens, retries a failed thread without publishing partial history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'psm-restart-'))
  const bus = new EventBus(),
    started = Promise.withResolvers()
  let stall = true,
    fail = true,
    sync
  const row = { id: 't', cwd: root, name: '优化方案', updatedAt: 1 }
  const hub = {
    status: () => ({ phase: 'ready' }),
    psmThreads: ({ archived }) => ({ data: archived ? [] : [row], nextCursor: null }),
    psmMetadata: () => row,
    psmTurns: async (id, cursor, signal) => {
      if (!cursor) return { data: turns('USB HUB掉线'), nextCursor: 'older' }
      started.resolve()
      if (stall) await delay(10000, null, { signal })
      if (fail) throw Error('page unavailable')
      return { data: [], nextCursor: null }
    },
  }
  const open = (paused) =>
    new PsmSync({ hub, bus, path: join(root, 'index.sqlite'), projectFor: () => root, paused })
  t.after(async () => {
    await sync?.close()
    bus.dispose()
    await rm(root, { recursive: true, force: true })
  })
  sync = open(false)
  await started.promise
  await sync.pause()
  assert.equal((await sync.status()).indexed, 0)
  await sync.close()
  sync = open(true)
  stall = false
  sync.resume()
  await sync.running
  assert.equal((await sync.status()).failed, 1)
  assert.deepEqual(await sync.db.call('search', { query: '掉线', projects: [root] }), [])
  fail = false
  sync.refresh()
  await sync.running
  assert.equal((await sync.status()).indexed, 1)
  assert.equal((await sync.db.call('search', { query: '掉线', projects: [root] })).length, 1)
})

test('tail reconciliation keeps older turns and only publishes a complete anchored page', () => {
  const db = new SourceIndex(':memory:')
  try {
    db.observe({ id: 't', project: 'p', title: 'title', state: 'active', stamp: 'a', seen: 's' })
    db.begin()
    db.stage(['old', 'anchor'].map((id) => ({ ...turns(id)[0], id })))
    db.commit(db.next())
    db.mark({ id: 't', tail: true })
    const row = db.next()
    assert.equal(row.tail, 1)
    db.begin()
    db.stage(['new', 'anchor'].map((id) => ({ ...turns(id + ' changed')[0], id })))
    assert.equal(db.anchor({ id: 't', ids: ['new', 'anchor'] }), true)
    db.commit(row)
    assert.equal(db.search({ query: 'old', projects: ['p'] }).length, 1)
    assert.equal(db.search({ query: 'changed', projects: ['p'] }).length, 2)
    db.mark({ id: 't', state: 'deleted' })
    assert.equal(db.progress().pending, 0)
    assert.equal(db.search({ query: 'changed', projects: ['p'] }).length, 0)
  } finally {
    db.close()
  }
})
