import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { FIXTURE_TOKEN, startFixture } from './fixtures/start-app.mjs'

const { outputFiles } = await build({ entryPoints: ['web/src/subagents.ts'], bundle: true, write: false, format: 'esm' })
const { applySubagentEvent, collectSubagents, mergeSubagentTurns, subagentStatus } =
  await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'))

test('parent activity anchors one row per child and supports both Codex protocols', () => {
  const items = [
    { id: 'start', type: 'subAgentActivity', agentThreadId: 'one', agentPath: '/root/inspect', kind: 'started' },
    { id: 'legacy', type: 'collabAgentToolCall', senderThreadId: 'parent', receiverThreadIds: ['two'],
      tool: 'spawnAgent', prompt: 'Assigned task', agentsStates: { two: { status: 'running' } } },
    { id: 'unrelated', type: 'subAgentActivity', agentThreadId: 'ancestor', agentPath: '/root', kind: 'interacted' },
    { id: 'second', type: 'subAgentActivity', agentThreadId: 'one', kind: 'completed' },
    { id: 'final', type: 'collabAgentToolCall', senderThreadId: 'parent', receiverThreadIds: ['one', 'two', 'unknown'],
      tool: 'wait', agentsStates: { two: { status: 'completed', message: 'Legacy result' } } },
  ]
  const anchors = [...collectSubagents(items, 'parent', 'ancestor')]
  assert.deepEqual(anchors, [
    ['start', [{ id: 'one', activityId: 'final', name: 'inspect', status: 'completed' }]],
    ['legacy', [{ id: 'two', activityId: 'final', name: 'two', status: 'completed', prompt: 'Assigned task', result: 'Legacy result' }]],
  ])
})

test('live item deltas stay exact across overlapping history and finalization', () => {
  const event = (type, payload) => ({ type, threadId: 'child', turnId: 'turn', itemId: 'item', channel: 'agentMessage', payload })
  let live = { thread: { id: 'child' }, turns: [] }
  const start = event('item/upsert', { item: { id: 'item', type: 'agentMessage', text: '', streaming: true } })
  live = applySubagentEvent(live, start)
  live = applySubagentEvent(live, event('item/delta', { delta: 'hello' }))
  const history = [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'agentMessage', text: 'hello world' }] }]
  const text = () => mergeSubagentTurns(history, live.turns)[0].items.map(item => item.text)
  assert.deepEqual(text(), ['hello world'])
  live = applySubagentEvent(live, event('item/delta', { delta: ' world' }))
  assert.deepEqual(text(), ['hello world'])
  live = applySubagentEvent(live, event('item/upsert', { completed: true, item: { id: 'item', type: 'agentMessage', text: 'hello world!' } }))
  live = applySubagentEvent(live, event('turn/completed', { turn: { id: 'turn', status: 'completed' } }))
  live = applySubagentEvent(live, start)
  assert.deepEqual(text(), ['hello world!'])
  assert.equal(subagentStatus(mergeSubagentTurns(history, live.turns)[0].status, { type: 'active' }, 'starting'), 'completed')
  assert.equal(subagentStatus('inProgress', { type: 'notLoaded' }, 'starting'), 'running')
})

test('authenticated child history paginates and rejects unrelated threads', async t => {
  const app = await startFixture()
  t.after(() => app.close())
  const endpoint = 'threads/subagent/get'
  const rpc = (payload, cookie = '') => fetch(app.origin + '/codex-cli/' + endpoint, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-codex-request': '1' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'subagent-test', method: endpoint, payload }),
  })
  const parentThreadId = 'fixture-thread'
  assert.equal((await rpc({ parentThreadId, agentThreadId: 'child' })).status, 401)
  const login = await fetch(app.origin + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-request': '1' },
    body: JSON.stringify({ token: FIXTURE_TOKEN }),
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  await app.hub.startTurn({ threadId: parentThreadId, text: '请触发旧版子代理执行' })
  const parent = await app.hub.getThread(parentThreadId)
  const [first, second] = parent.turns.at(-1).items.filter(item => item.type === 'collabAgentToolCall')
  const kepler = { parentThreadId, agentThreadId: first.receiverThreadIds[0] }
  const get = async payload => (await (await rpc(payload, cookie)).json()).result
  const metadata = (await get({ ...kepler, metadataOnly: true })).value
  assert.equal(metadata.thread.agentNickname, 'Kepler')
  assert.deepEqual(metadata.turns, [])
  const page = (await get(kepler)).value
  assert.equal(page.historyAvailable, true)
  assert.equal(page.turns.length, 2)
  assert.equal(page.turns.at(-1).status, 'inProgress')
  const older = (await get({ ...kepler, cursor: page.nextCursor })).value
  assert.equal(older.turns.length, 1)
  assert.equal(older.nextCursor, null)
  const missing = (await get({ parentThreadId, agentThreadId: second.receiverThreadIds[0] })).value
  assert.equal(missing.historyAvailable, false)
  assert.deepEqual(missing.turns, [])
  const unrelated = await get({ ...kepler, parentThreadId: second.receiverThreadIds[0] })
  assert.equal(unrelated.ok, false)
  assert.equal(unrelated.error.code, 'codex-cli/subagent-not-found')
  assert.deepEqual(app.hub.status().subscriptions, [])
})
