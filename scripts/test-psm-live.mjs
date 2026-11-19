// Read-only probe of one explicitly selected local Codex thread. No model turn.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexHub } from '../server/codex/hub.js'
import { normalizeConfig } from '../server/codex/config.js'
import { EventBus } from '../server/services/events.js'
import { PsmSync } from '../server/router/psm-sync.js'
import { visibleText } from '../server/router/psm-index.js'

const {
  CODEX_WEB_PSM_LIVE: enabled,
  PSM_THREAD: id,
  PSM_QUERY: query,
  PSM_CWD: cwd,
  CODEX_WEB_LIVE_HOME: home,
} = process.env
if (enabled !== '1' || !id || !query || !cwd || !isAbsolute(cwd) || !home || !isAbsolute(home))
  throw new Error('Set CODEX_WEB_PSM_LIVE=1, PSM_THREAD, PSM_QUERY, PSM_CWD and CODEX_WEB_LIVE_HOME')
const dir = await mkdtemp(join(tmpdir(), 'psm-live-')),
  bus = new EventBus()
const hub = new CodexHub({ config: normalizeConfig({ transport: 'stdio', codexHome: home }), bus })
let sync
try {
  hub.start()
  const deadline = Date.now() + 120000
  while (hub.status().phase !== 'ready') {
    assert.ok(Date.now() < deadline, 'App Server handshake timeout')
    await delay(100)
  }
  const thread = await hub.psmMetadata(id)
  assert.equal(thread.cwd, cwd)
  // Enumerate real history pages, indexing only the selected thread.
  const source = {
    status: () => hub.status(),
    psmThreads: async (params, signal) => {
      const page = await hub.psmThreads(params, signal)
      return { ...page, data: page.data.filter((t) => t.id === id) }
    },
    psmMetadata: hub.psmMetadata.bind(hub),
    psmTurns: hub.psmTurns.bind(hub),
  }
  const start = performance.now()
  sync = new PsmSync({
    hub: source,
    bus,
    path: join(dir, 'index.sqlite'),
    projectFor: (path) => (path === cwd ? 'test-project' : null),
  })
  let status
  do {
    status = await sync.status()
    assert.ok(status.phase !== 'failed' && !status.failed, 'Index scan failed')
    assert.ok(Date.now() < deadline, 'History indexing timeout')
    if (status.phase !== 'idle') await delay(100)
  } while (status.phase !== 'idle')
  assert.equal(status.indexed, 1, 'Thread outside enumerated worker history')
  const indexMs = Math.round(performance.now() - start)
  const samples = []
  let hits
  for (let i = 0; i < 20; i++) {
    const before = performance.now()
    hits = await sync.db.call('search', { query, projects: ['test-project'] })
    samples.push(performance.now() - before)
  }
  const searchP95Ms = Number(samples.sort((a, b) => a - b)[18].toFixed(2))
  assert.ok(hits.length, 'No result for history query')
  const hit = hits[0]
  let cursor,
    verified = false
  do {
    const page = await hub.psmTurns(id, cursor)
    const item = page.data.find((t) => t.id === hit.turn)?.items.find((i) => i.id === hit.item)
    if (item) verified = visibleText(item).includes(hit.body)
    cursor = page.nextCursor
  } while (!verified && cursor)
  assert.ok(verified, 'Source fragment mismatch')
  console.log(
    JSON.stringify({
      version: hub.status().codexVersion,
      thread: id,
      query,
      hits: hits.length,
      verified,
      indexMs,
      searchP95Ms,
    }),
  )
} finally {
  await sync?.close()
  await hub.stop()
  bus.dispose()
  await rm(dir, { recursive: true, force: true })
}
