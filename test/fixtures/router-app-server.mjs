import { createServer } from 'node:http'
import { JsonRpcClient } from '../../server/codex/jsonrpc.js'
import { StdioTransport } from '../../server/codex/transport/stdio.js'

export const namespace = 'router_a1'
export const toolName = 'lookup_fixture'
export const dynamicTools = [{
  type: 'namespace',
  name: namespace,
  description: 'Read a synthetic fixture record.',
  tools: [{
    type: 'function',
    name: toolName,
    description: 'Return a marker for the requested fixture record.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', enum: ['fixture'] } },
      required: ['key'],
      additionalProperties: false,
    },
  }],
}]

function toolResult(success, text) {
  return { success, contentItems: [{ type: 'inputText', text }] }
}

export function fixtureToolHandler({ threadId, turnId, records = new Map(), lookup }) {
  return ({ method, params }) => {
    if (method !== 'item/tool/call') throw Object.assign(new Error('Request method denied'), { code: -32601 })
    if (!params || params.threadId !== threadId || !turnId() || params.turnId !== turnId() ||
        params.namespace !== namespace || params.tool !== toolName ||
        typeof params.callId !== 'string' || params.callId === '') {
      return toolResult(false, 'Call scope denied')
    }
    const args = params.arguments
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).length !== 1 || args.key !== 'fixture') {
      return toolResult(false, 'Invalid fixture arguments')
    }
    const key = JSON.stringify([threadId, params.turnId, params.callId])
    if (!records.has(key)) records.set(key, toolResult(true, lookup(args.key)))
    return records.get(key)
  }
}

export function dynamicCall(callId, args = { key: 'fixture' }) {
  return {
    type: 'function_call',
    name: toolName,
    namespace,
    call_id: callId,
    arguments: JSON.stringify(args),
  }
}

export function assistantMessage(text) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
}

export async function startResponsesFixture() {
  const requests = []
  const steps = []
  const unexpected = []
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        // Optional catalog and support requests have no live counterpart.
        response.writeHead(404).end()
        return
      }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(body)
      const step = steps.shift()
      if (!step) {
        unexpected.push(request.url)
        response.writeHead(500).end()
        return
      }
      const item = await step(body)
      if (response.destroyed) return
      const id = 'fixture-' + requests.length
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item: { id: 'item-' + id, ...item } },
        { type: 'response.completed', response: {
          id,
          usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 },
        } },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
      response.end()
    } catch (error) {
      unexpected.push(error.message)
      response.destroy()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    enqueue: (...responses) => steps.push(...responses.map(item => typeof item === 'function' ? item : () => item)),
    requests,
    unexpected,
    get remaining() { return steps.length },
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

export async function connectAppServer({ command, args, env, cwd, prefix = [], experimentalApi = true,
  clientName = 'router-a1', transport = new StdioTransport({ command, args: [...prefix, 'app-server', ...args], env, cwd }) }) {
  const events = []
  const rpc = new JsonRpcClient({ send: message => transport.send(message), logger: { warn() {} } })
  transport.onMessage(message => {
    events.push(message)
    rpc.handleMessage(message)
  })
  transport.onClose(() => rpc.close('Fixture App Server exited'))
  const request = async (method, params) => {
    try {
      return await rpc.request(method, params, { timeoutMs: 20000 })
    } catch (error) {
      if (rpc.closed || error.code === -32001) error.message += '\n' + transport.stderrTail
      throw error
    }
  }
  const close = () => {
    rpc.close()
    transport.close()
  }
  try {
    await transport.open()
    const info = await request('initialize', {
      clientInfo: { name: clientName, title: 'Router protocol fixture', version: '0.1.0' },
      capabilities: { experimentalApi },
    })
    rpc.notify('initialized')
    return { request, rpc, events, info, close, get stderr() { return transport.stderrTail } }
  } catch (error) {
    close()
    throw error
  }
}

export async function waitFor(source, predicate, description) {
  for (let attempt = 0; attempt < 900; attempt++) {
    const match = source.find(predicate)
    if (match) return match
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for ' + description)
}
