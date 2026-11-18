import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { JsonRpcClient } from '../server/codex/jsonrpc.js'
import { fixtureToolHandler, namespace, toolName } from './fixtures/router-app-server.mjs'

const params = {
  threadId: 'router-thread', turnId: 'router-turn', callId: 'tool-call',
  namespace, tool: toolName, arguments: { key: 'fixture' },
}

function clientFixture(records = new Map()) {
  let lookups = 0
  const sent = []
  const rpc = new JsonRpcClient({ send: message => sent.push(message), logger: { warn() {} } })
  rpc.onServerRequest(fixtureToolHandler({
    threadId: params.threadId,
    turnId: () => params.turnId,
    records,
    lookup: () => 'fixture-result-' + (++lookups),
  }))
  return {
    rpc, sent, get lookups() { return lookups },
    async call(id, fields = {}, method = 'item/tool/call') {
      rpc.handleMessage({ id, method, params: { ...params, ...fields } })
      await setImmediate()
      return sent.at(-1)
    },
  }
}

test('dynamic tool fixture responds on the incoming RPC id and deduplicates call replay', async () => {
  const records = new Map()
  const first = clientFixture(records)
  const initial = await first.call(21)
  assert.deepEqual(initial, {
    id: 21,
    result: { success: true, contentItems: [{ type: 'inputText', text: 'fixture-result-1' }] },
  })
  first.rpc.close()
  const reconnected = clientFixture(records)
  assert.deepEqual(await reconnected.call('replayed-rpc-id'), { ...initial, id: 'replayed-rpc-id' })
  assert.equal(first.lookups, 1)
  assert.equal(reconnected.lookups, 0)
})

test('dynamic tool fixture denies foreign scope, invalid arguments and ordinary approvals', async () => {
  const client = clientFixture()
  for (const patch of [
    { threadId: 'worker-thread' }, { turnId: 'completed-turn' }, { namespace: 'other' },
    { tool: 'other' }, { callId: '' }, { arguments: { key: 'fixture', extra: true } },
    { arguments: null }, { arguments: { key: 'other' } },
  ]) {
    assert.equal((await client.call(22, patch)).result.success, false)
  }
  assert.equal((await client.call(23, {}, 'item/commandExecution/requestApproval')).error.code, -32601)
  assert.equal(client.lookups, 0)
})

test('closing JSON-RPC suppresses a late dynamic tool response on the ended connection', async () => {
  const sent = []
  const pending = Promise.withResolvers()
  const rpc = new JsonRpcClient({ send: message => sent.push(message), logger: { warn() {} } })
  rpc.onServerRequest(() => pending.promise)
  rpc.handleMessage({ id: 24, method: 'item/tool/call', params })
  await setImmediate()
  rpc.close()
  pending.resolve({ success: true, contentItems: [] })
  await setImmediate()
  assert.deepEqual(sent, [])
})
