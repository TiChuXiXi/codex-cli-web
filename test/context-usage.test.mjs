import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transform } from 'esbuild'
import { readContextUsage } from '../server/services/context-usage.js'
import { contextUsage } from '../web/src/context-usage.ts'
import { CodexHub } from '../server/codex/hub.js'
import { normalizeConfig } from '../server/codex/config.js'
import { EventBus } from '../server/services/events.js'

const { code } = await transform(await (await import('node:fs/promises')).readFile(new URL('../web/src/utils.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' })
const { applyDetailEvent } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const usage = (used, limit = 258000) => ({ last: { totalTokens: used }, total: { totalTokens: 3000000 }, modelContextWindow: limit })

test('context uses the latest request, including zero and decreases after compaction', () => {
  assert.deepEqual(contextUsage(usage(147000)), { used: 147000, limit: 258000, percent: 57 })
  assert.equal(contextUsage(usage(0)).percent, 0)
  assert.equal(contextUsage(usage(300000)).percent, 100)
  assert.equal(contextUsage(usage(10000)).percent, 4)
  for (const invalid of [null, undefined, -1, NaN, Infinity, '258000']) {
    assert.equal(contextUsage({ ...usage(147000), modelContextWindow: invalid }).percent, null)
  }
  assert.deepEqual(contextUsage(null), { used: null, limit: null, percent: null })
})

test('usage events affect only the matching thread and preserve turns', () => {
  const detail = { thread: { id: 'a' }, turns: [], tokenUsage: usage(147000) }
  const event = { type: 'thread/usage', threadId: 'a', payload: { tokenUsage: usage(10000) } }
  assert.equal(applyDetailEvent(detail, { ...event, threadId: 'b' }), detail)
  assert.equal(applyDetailEvent(detail, { ...event, threadId: undefined }), detail)
  assert.equal(applyDetailEvent(null, event), null)
  const next = applyDetailEvent(detail, event)
  assert.equal(next.tokenUsage.last.totalTokens, 10000)
  assert.equal(next.turns, detail.turns)
  assert.equal(applyDetailEvent(next, { ...event, payload: { tokenUsage: null } }).tokenUsage, null)
})

test('rollout snapshot skips quota-only events and incomplete lines, restoring the latest context', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'rollout.jsonl')
  const record = used => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: { total_tokens: used, input_tokens: used - 100, output_tokens: 100 },
    total_token_usage: { total_tokens: 3000000 }, model_context_window: 258000,
  } } })
  await writeFile(path, ['x'.repeat(2 * 1024 * 1024 + 100), record(147000), record(10000),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
    '{"type":"event_msg","payload":{"type":"token_count"'].join('\n'))
  const result = await readContextUsage(path)
  assert.equal(result.last.totalTokens, 10000)
  assert.equal(result.total.totalTokens, 3000000)
  assert.equal(result.modelContextWindow, 258000)
  assert.equal(await readContextUsage(join(root, 'missing.jsonl')), null)
  assert.equal(await readContextUsage(null), null)
  await writeFile(path, '{"type":"session_meta"}\n')
  assert.equal(await readContextUsage(path), null)
})

test('Hub returns live usage received during history loading and handles ephemeral fallback', async t => {
  const { chmod } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'codex-context-rpc-'))
  const script = join(root, 'codex.mjs')
  const source = `
import {createInterface} from 'node:readline'
const send = value => process.stdout.write(JSON.stringify(value)+'\\n')
createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line)
  if(m.id===undefined)return
  const id=m.params?.threadId
  let result={}
  if(m.method==='initialize')result={userAgent:'codex/0.167.0'}
  if(m.method==='thread/read'){
    if(id==='ephemeral'&&m.params.includeTurns)return send({id:m.id,error:{code:-32600,message:'ephemeral'}})
    result={thread:{id,path:null}}
  }
  if(m.method==='thread/turns/list'){
    if(id==='ephemeral')return send({id:m.id,error:{code:-32600,message:'ephemeral'}})
    send({method:'thread/tokenUsage/updated',params:{threadId:id,tokenUsage:{last:{totalTokens:147000},modelContextWindow:258000}}})
    result={data:[],nextCursor:null}
  }
  send({id:m.id,result})
})
`
  await writeFile(script, '#!'+process.execPath+'\n'+source)
  await chmod(script, 0o755)
  const bus=new EventBus()
  const hub=new CodexHub({config:normalizeConfig({transport:'stdio',codexPath:script,codexHome:root}),logger:{},bus})
  t.after(async()=>{await hub.stop();bus.dispose();await rm(root,{recursive:true,force:true})})
  hub.start()
  const deadline=Date.now()+5000
  while(hub.status().phase!=='ready'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10))
  assert.equal(hub.status().phase,'ready',hub.status().error)
  assert.equal((await hub.getThread('live')).tokenUsage.last.totalTokens,147000)
  assert.equal((await hub.getThread('ephemeral')).tokenUsage,null)
})
