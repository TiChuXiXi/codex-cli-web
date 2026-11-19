import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexHub } from '../server/codex/hub.js'
import { normalizeConfig } from '../server/codex/config.js'
import { EventBus } from '../server/services/events.js'

async function waitUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('Hub did not reach the expected state')
}

test('Worker retains a separate Hub reference, restores it on reconnect, and reads older associated results', async t => {
  const bus = new EventBus()
  const calls = []
  const connections = []
  const threadId = 'worker-fixture'
  const config = normalizeConfig({ transport: 'stdio', reconnectBaseMs: 100 })
  const hub = new CodexHub({
    config, bus,
    openTransport: async () => {
      let receive
      let close
      const index = connections.length
      connections.push({ drop: () => close({ reason: 'test disconnect' }), emit: message => receive(message) })
      return {
        kind: 'stdio', socketPath: null,
        transport: {
          onMessage(handler) { receive = handler; return () => {} },
          onClose(handler) { close = handler; return () => {} },
          close() {},
          send(message) {
            if (message.id === undefined) return
            calls.push({ ...message, index })
            const { method, params } = message
            let result = {}
            if (method === 'thread/resume') result = { cwd: '/fixture', approvalPolicy: 'never',
              approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } }
            if (method === 'thread/read') result = { thread: { id: threadId, status: { type: 'idle' } } }
            if (method === 'thread/turns/list') result = params.cursor
              ? { data: [{ id: 'older', status: 'completed', items: [{ type: 'userMessage', clientId: 'dispatch' }] }] }
              : { data: [{ id: 'newer', status: 'completed' }], nextCursor: 'older-page' }
            if (method === 'thread/queue/list') result = params.cursor
              ? { data: [{ id: 'older-queue-entry', clientUserMessageId: 'dispatch' }] }
              : { data: [], nextCursor: 'older-queue-page' }
            queueMicrotask(() => receive({ id: message.id, result }))
          },
        },
      }
    },
  })
  t.after(async () => { await hub.stop(); bus.dispose() })
  hub.start()
  await waitUntil(() => hub.status().phase === 'ready')
  const effective = await hub.routerWorkerSettings('candidate')
  assert.equal(effective.approvalPolicy, 'never')
  assert.equal(effective.sandbox.type, 'dangerFullAccess')
  assert.deepEqual(calls.filter(call => call.params?.threadId === 'candidate').map(call => call.method),
    ['thread/resume', 'thread/unsubscribe'])
  calls.length = 0
  await Promise.all([hub.openThread(threadId), hub.openThread(threadId, { routerWorker: true })])
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1)
  assert.equal((await hub.closeThread(threadId)).subscribers, 1)
  assert.equal((await hub.closeThread(threadId)).subscribers, 1)
  assert.equal(calls.some(call => call.method === 'thread/unsubscribe'), false)

  connections[0].drop()
  await waitUntil(() => calls.some(call => call.index === 1 && call.method === 'thread/resume'))
  await hub.ensureThreadSubscription(threadId)
  const events = []
  bus.subscribe(event => events.push(event))
  connections[1].emit({ method: 'thread/settings/updated', params: { threadId, threadSettings: {
    cwd: '/fixture', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false },
  } } })
  assert.equal(hub.getThreadSettings(threadId).sandbox.type, 'readOnly')
  assert.ok(events.some(event => event.type === 'thread/settings' && event.threadId === threadId &&
    event.payload.settings.sandbox.type === 'readOnly'))
  connections[1].emit({ method: 'turn/completed', params: { threadId, turn: { id: 'older', status: 'completed' } } })
  assert.ok(events.some(event => event.type === 'turn/completed' && event.turnId === 'older'))
  assert.equal((await hub.routerReadWorker(threadId, { clientId: 'dispatch' })).turns[0].id, 'older')
  assert.equal((await hub.routerFindWorkerMessage(threadId, 'dispatch')).id, 'older-queue-entry')
  await hub.routerAddWorkerMessage(threadId, 'dispatch', '复核离线颜色')
  await hub.routerStartWorkerMessage(threadId, 'older-queue-entry')
  assert.deepEqual(calls.find(call => call.method === 'thread/queue/add').params, {
    threadId, clientUserMessageId: 'dispatch', input: [{ type: 'text', text: '复核离线颜色', text_elements: [] }],
  })
  assert.deepEqual(calls.find(call => call.method === 'thread/queue/start').params, {
    threadId, queuedSubmissionId: 'older-queue-entry',
  })
  assert.equal((await hub.closeThread(threadId, { routerWorker: true })).subscribers, 0)
  assert.equal(calls.filter(call => call.method === 'thread/unsubscribe').length, 1)
})
