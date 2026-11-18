import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexHub } from '../server/codex/hub.js'
import { normalizeConfig } from '../server/codex/config.js'

async function fixture(t, overrides = {}) {
  let receive
  const calls = []
  const transport = {
    onMessage(handler) { receive = handler; return () => {} },
    onClose() { return () => {} },
    close() {},
    send(message) {
      if (!message.method || message.id === undefined) return
      calls.push(message)
      queueMicrotask(() => {
        const { method, params } = message
        const result = method === 'thread/start'
          ? { thread: { id: `work-${calls.length}`, model: params.model, reasoningEffort: params.effort }, model: params.model, reasoningEffort: params.effort }
          : {}
        receive({ id: message.id, result })
      })
    },
  }
  const hub = new CodexHub({
    config: normalizeConfig({ transport: 'stdio', ...overrides }),
    logger: {}, bus: { publish() {}, publishDelta() {} },
    openTransport: async () => ({ transport, kind: 'stdio', socketPath: null }),
  })
  t.after(() => hub.stop())
  hub.start()
  for (let i = 0; i < 200 && hub.status().phase !== 'ready'; i++) await delay(5)
  assert.equal(hub.status().phase, 'ready')
  return { hub, calls }
}

test('ordinary and Router-created Worker threads send Sol with medium reasoning by default', async t => {
  const { hub, calls } = await fixture(t)
  for (const routerWorker of [false, true]) {
    const thread = await hub.newThread({ cwd: '/fixture', sandbox: 'read-only' }, { routerWorker })
    assert.equal(thread.model, 'gpt-6.2-sol')
    assert.equal(thread.reasoningEffort, 'medium')
    const request = calls.filter(call => call.method === 'thread/start').at(-1).params
    assert.equal(request.model, 'gpt-6.2-sol')
    assert.equal(request.effort, 'medium')
    if (routerWorker) assert.equal(request.approvalsReviewer, 'user')
  }
})

test('explicit selection overrides application defaults and existing turns receive no forced model', async t => {
  const { hub, calls } = await fixture(t, { defaultModel: 'configured-model', defaultEffort: 'high' })
  const configured = await hub.newThread()
  assert.equal(configured.model, 'configured-model')
  assert.equal(configured.reasoningEffort, 'high')
  const selected = await hub.newThread({ model: 'chosen-model', effort: 'low' })
  assert.equal(selected.model, 'chosen-model')
  assert.equal(selected.reasoningEffort, 'low')
  await hub.startTurn({ threadId: 'existing', text: 'Continue existing work' })
  const turn = calls.find(call => call.method === 'turn/start').params
  assert.equal(Object.hasOwn(turn, 'model'), false)
  assert.equal(Object.hasOwn(turn, 'effort'), false)
})
