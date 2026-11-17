import test from 'node:test'
import assert from 'node:assert/strict'
import { FollowupQueue } from '../server/services/followups.js'
import { EventBus } from '../server/services/events.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await flush() }
  assert.fail('queue did not settle')
}
function fixture(t, { active = 'initial', start, steer, read } = {}) {
  const bus = new EventBus(), calls = [], subscriptions = new Map(), turns = new Map([['a', active], ['b', null]])
  let count = 0
  const hub = {
    async openThread(id) { subscriptions.set(id, (subscriptions.get(id) || 0) + 1) },
    async closeThread(id) { subscriptions.set(id, (subscriptions.get(id) || 0) - 1) },
    async getThread(id) {
      if (read) return read(id)
      const turn = turns.get(id)
      return { thread: { id, status: { type: turn ? 'active' : 'idle' } }, turns: turn ? [{ id: turn, status: 'inProgress' }] : [] }
    },
    async startTurn(params) {
      calls.push(['start', structuredClone(params)])
      if (start) return start(params, bus)
      const turn = { id: 'queued-' + ++count, status: 'inProgress' }
      turns.set(params.threadId, turn.id)
      bus.publish('turn/started', { turn }, { threadId: params.threadId, turnId: turn.id })
      return { turn }
    },
    async steerTurn(params) { calls.push(['steer', structuredClone(params)]); if (steer) await steer(params) },
  }
  const queue = new FollowupQueue({ hub, bus })
  t.after(() => { queue.dispose(); bus.dispose() })
  const complete = (id = 'a', status = 'completed') => {
    const turnId = turns.get(id)
    turns.set(id, null)
    bus.publish('turn/completed', { turn: { id: turnId, status } }, { threadId: id, turnId })
  }
  return { queue, bus, calls, complete, subscriptions, turns }
}

test('FIFO runs on host after current turn, keeps options, and releases its subscription', async t => {
  const f = fixture(t)
  const params = { threadId: 'a', text: '$skill first', model: 'model', effort: 'high', skills: [{ name: 'skill', path: '/tmp/SKILL.md' }], attachments: [{ name: 'file', path: '/tmp/file', kind: 'file' }], collaborationMode: { mode: 'plan' }, approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } }
  await f.queue.enqueue(params)
  await f.queue.enqueue({ threadId: 'a', text: 'second' })
  assert.equal(f.calls.length, 0)
  assert.equal(f.subscriptions.get('a'), 1)
  f.complete()
  await until(() => f.calls.length === 1)
  assert.deepEqual(f.calls[0][1], params)
  await flush()
  assert.equal(f.calls.length, 1)
  f.complete()
  await until(() => f.calls.length === 2 && f.queue.list('a').entries.length === 0)
  assert.equal(f.calls[1][1].text, 'second')
  assert.equal(f.subscriptions.get('a'), 0)
})

test('edit holds FIFO without overwriting composer drafts, cancel/save/delete preserve order', async t => {
  const f = fixture(t)
  const first = (await f.queue.enqueue({ threadId: 'a', text: 'one' })).entries[0]
  const second = (await f.queue.enqueue({ threadId: 'a', text: 'two' })).entries[1]
  await f.queue.action({ threadId: 'a', id: first.id, action: 'edit' })
  f.complete()
  await flush()
  assert.equal(f.calls.length, 0)
  await f.queue.action({ threadId: 'a', id: second.id, action: 'delete' })
  await assert.rejects(f.queue.action({ threadId: 'a', id: first.id, action: 'save', text: '' }))
  await f.queue.action({ threadId: 'a', id: first.id, action: 'save', text: 'revised' })
  await until(() => f.calls.length === 1)
  assert.equal(f.calls[0][1].text, 'revised')
  await assert.rejects(f.queue.action({ threadId: 'a', id: first.id, action: 'delete' }))
})

test('Steer forwards attachments and removes only the accepted item; failure retains it', async t => {
  let fail = true
  const f = fixture(t, { steer: async () => { if (fail) throw Error('steer failed') } })
  const params = { threadId: 'a', text: 'image', attachments: [{ name: 'img', kind: 'image', path: '/tmp/img' }] }
  const entry = (await f.queue.enqueue(params)).entries[0]
  await assert.rejects(f.queue.action({ threadId: 'a', id: entry.id, action: 'steer' }), /steer failed/)
  assert.equal(f.queue.list('a').entries[0].error, 'steer failed')
  fail = false
  await f.queue.action({ threadId: 'a', id: entry.id, action: 'steer' })
  assert.deepEqual(f.calls.at(-1), ['steer', { ...params, turnId: 'initial' }])
  assert.equal(f.queue.list('a').entries.length, 0)
})

test('failed starts pause queue, retain messages and require explicit resume', async t => {
  let fail = true
  const f = fixture(t, { active: null, start: async () => { if (fail) throw Error('offline'); return { turn: { id: 'retry', status: 'inProgress' } } } })
  await f.queue.enqueue({ threadId: 'a', text: 'preserved' })
  await until(() => f.queue.list('a').paused)
  assert.equal(f.queue.list('a').entries[0].error, 'offline')
  await f.queue.enqueue({ threadId: 'a', text: 'later' })
  await flush()
  assert.equal(f.calls.length, 1)
  fail = false
  await f.queue.action({ threadId: 'a', action: 'resume' })
  await until(() => f.calls.length === 2)
  assert.equal(f.calls[1][1].text, 'preserved')
})

test('completion before start acknowledgement and duplicate events never double dispatch', async t => {
  let sequence = 0
  const f = fixture(t, { start: async (params, bus) => {
    const turn = { id: 'fast-' + ++sequence, status: 'inProgress' }
    bus.publish('turn/started', { turn }, { threadId: 'a', turnId: turn.id })
    const completed = { turn: { ...turn, status: 'completed' } }
    bus.publish('turn/completed', completed, { threadId: 'a', turnId: turn.id })
    bus.publish('turn/completed', completed, { threadId: 'a', turnId: turn.id })
    await flush()
    return { turn }
  } })
  await f.queue.enqueue({ threadId: 'a', text: 'one' })
  await f.queue.enqueue({ threadId: 'a', text: 'two' })
  f.complete()
  await until(() => f.queue.list('a').entries.length === 0)
  assert.deepEqual(f.calls.map(call => call[1].text), ['one', 'two'])
})

test('interruptions pause remaining messages; other threads run independently', async t => {
  const f = fixture(t)
  await f.queue.enqueue({ threadId: 'a', text: 'waiting' })
  f.complete('a', 'interrupted')
  await f.queue.enqueue({ threadId: 'b', text: 'independent' })
  await until(() => f.calls.length === 1)
  assert.equal(f.calls[0][1].threadId, 'b')
  assert.equal(f.queue.list('a').paused, true)
  await f.queue.action({ threadId: 'a', action: 'resume' })
  await until(() => f.calls.length === 2)
})

test('live notifications beat stale initial history; dispose prevents further dispatch', async t => {
  let finishRead
  const f = fixture(t, { read: async () => new Promise(resolve => { finishRead = resolve }) })
  const adding = f.queue.enqueue({ threadId: 'a', text: 'queued' })
  await until(() => finishRead)
  f.bus.publish('turn/started', { turn: { id: 'live', status: 'inProgress' } }, { threadId: 'a', turnId: 'live' })
  finishRead({ thread: { status: { type: 'idle' } }, turns: [] })
  await adding
  await flush()
  assert.equal(f.calls.length, 0)
  f.queue.dispose()
  f.bus.publish('turn/completed', { turn: { status: 'completed' } }, { threadId: 'a', turnId: 'live' })
  await flush()
  assert.equal(f.calls.length, 0)
})

test('connection loss pauses without retrying a possibly accepted message', async t => {
  const f = fixture(t)
  await f.queue.enqueue({ threadId: 'a', text: 'waiting' })
  f.bus.publish('connection', { phase: 'connecting' })
  f.complete()
  await flush()
  assert.equal(f.calls.length, 0)
  assert.equal(f.queue.list('a').paused, true)
})


test('active status with delayed turn history waits for completion instead of starting early', async t => {
  const f = fixture(t, { read: async () => ({ thread: { status: { type: 'active' } }, turns: [] }) })
  await f.queue.enqueue({ threadId: 'a', text: 'wait' })
  await flush()
  assert.equal(f.calls.length, 0)
  f.complete()
  await until(() => f.calls.length === 1)
})

test('failed turn returned without a notification pauses subsequent queued messages', async t => {
  const f = fixture(t, { start: async () => ({ turn: { id: 'failed', status: 'failed' } }) })
  await f.queue.enqueue({ threadId: 'a', text: 'one' })
  await f.queue.enqueue({ threadId: 'a', text: 'two' })
  f.complete()
  await until(() => f.queue.list('a').paused)
  assert.equal(f.calls.length, 1)
  assert.equal(f.queue.list('a').entries[0].params.text, 'two')
})

test('provider connection failures pause only queues owned by that provider', async t => {
  const f = fixture(t, { read: async id => ({ thread: { modelProvider: id === 'a' ? 'opencode-go' : 'openai', status: { type: 'active' } }, turns: [{ id: id + '-active', status: 'inProgress' }] }) })
  await f.queue.enqueue({ threadId: 'a', text: 'go queue' })
  await f.queue.enqueue({ threadId: 'b', text: 'primary queue' })
  f.bus.publish('provider/connection', { provider: 'opencode-go', phase: 'error' })
  assert.equal(f.queue.list('a').paused, true)
  assert.equal(f.queue.list('b').paused, false)
})

test('dispose during initial history read rejects the enqueue and releases subscription', async t => {
  let finish
  const f = fixture(t, { read: async () => new Promise(resolve => { finish = resolve }) })
  const adding = f.queue.enqueue({ threadId: 'a', text: 'never send' })
  await until(() => finish)
  f.queue.dispose()
  finish({ thread: { status: { type: 'idle' } }, turns: [] })
  await assert.rejects(adding, /队列已停止/)
  assert.equal(f.subscriptions.get('a'), 0)
  assert.equal(f.calls.length, 0)
})

test('permission changes after enqueue apply to automatic turns, preserve content and stay thread-local', async t => {
  const { permissionPayload } = await import('../web/src/permissions.ts')
  for (const mode of ['full', 'read', 'approve', 'ask']) {
    await t.test(mode, async t => {
      const f = fixture(t)
      f.turns.set('b', 'other-active')
      const params = { threadId: 'a', text: 'queued', model: 'model', effort: 'high', attachments: [{ kind: 'image', name: 'image.png', path: '/tmp/image.png' }], ...permissionPayload(mode === 'full' ? 'read' : 'full') }
      await f.queue.enqueue(params)
      await f.queue.enqueue({ ...params, text: 'second' })
      await f.queue.enqueue({ ...params, threadId: 'b', text: 'other' })
      const settings = permissionPayload(mode)
      // Completion can race with the permission RPC; the queue lock must apply the edit first.
      const updating = f.queue.updatePermissions({ threadId: 'a', ...settings })
      f.complete()
      await updating
      await until(() => f.calls.length === 1)
      assert.deepEqual(f.calls[0][1], { ...params, ...settings })
      assert.equal(f.queue.list('b').entries[0].params.approvalPolicy, params.approvalPolicy)
      f.complete()
      await until(() => f.calls.length === 2)
      assert.deepEqual(f.calls[1][1], { ...params, text: 'second', ...settings })
    })
  }
})

test('latest permission update wins for edited entries without resuming the queue', async t => {
  const f = fixture(t)
  const entry = (await f.queue.enqueue({ threadId: 'a', text: 'editable' })).entries[0]
  await f.queue.action({ threadId: 'a', id: entry.id, action: 'edit' })
  f.queue.pause('a')
  const full = { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }
  const read = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  await Promise.all([f.queue.updatePermissions({ threadId: 'a', ...full }), f.queue.updatePermissions({ threadId: 'a', ...read })])
  assert.equal(f.queue.list('a').paused, true)
  assert.equal(f.queue.list('a').entries[0].status, 'editing')
  await f.queue.action({ threadId: 'a', id: entry.id, action: 'save', text: 'saved' })
  f.complete()
  await flush()
  assert.equal(f.calls.length, 0)
  await f.queue.action({ threadId: 'a', action: 'resume' })
  await until(() => f.calls.length === 1)
  assert.deepEqual(f.calls[0][1], { threadId: 'a', text: 'saved', attachments: [], ...read })
  await assert.rejects(f.queue.updatePermissions({ threadId: 'a', ...read, sandboxPolicy: { type: 'invalid' } }), /无效的会话权限/)
})
