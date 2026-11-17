import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {transform} from 'esbuild'
async function source(path){const {code}=await transform(await readFile(new URL(path,import.meta.url),'utf8'),{loader:'ts',format:'esm'});return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))}
const {runningStartedAt,activeTurnIdOf}=await source('../web/src/running-time.ts')
const {applyDetailEvent}=await source('../web/src/utils.ts')
const now=1794023607854,observed=now-3000
test('refresh replay cannot hide the current timer behind older completed or incomplete turns',()=>{
 const active={id:'current',status:'inProgress',startedAt:(now-95000)/1000}
 const detail={thread:{id:'thread',status:{type:'active'}},turns:[active]}
 let replayed=applyDetailEvent(detail,{type:'turn/started',threadId:'thread',payload:{turn:{id:'old',status:'inProgress',startedAt:(now-300000)/1000}}})
 replayed=applyDetailEvent(replayed,{type:'turn/completed',threadId:'thread',turnId:'old',payload:{turn:{id:'old',status:'completed',startedAt:(now-300000)/1000}}})
 assert.equal(activeTurnIdOf(replayed,now),'current')
 const old=now-400000,hex=old.toString(16).padStart(12,'0')
 replayed.turns.push({id:hex.slice(0,8)+'-'+hex.slice(8)+'-7000-8000-000000000000',status:'inProgress'})
 assert.equal(activeTurnIdOf(replayed,now),'current')
})
test('a finished latest turn or idle thread does not revive stale in-progress turns',()=>{
 const detail={thread:{status:{type:'active'}},turns:[
  {id:'finished',status:'completed',startedAt:(now-95000)/1000},
  {id:'stale',status:'inProgress',startedAt:(now-300000)/1000},
 ]}
 assert.equal(activeTurnIdOf(detail,now),null)
 detail.turns[0].status='inProgress'
 detail.thread.status.type='idle'
 assert.equal(activeTurnIdOf(detail,now),null)
 assert.equal(activeTurnIdOf(null,now),null)
})
test('uses real turn timestamps in seconds and milliseconds before fallback',()=>{
 assert.equal(runningStartedAt({id:'old',startedAt:(now-96000)/1000},observed,now),now-96000)
 assert.equal(runningStartedAt({id:'old',startedAt:now-96000},observed,now),now-96000)
})
test('uses UUIDv7 or earliest item timestamp when the server has no turn start',()=>{
 const started=now-75000,hex=started.toString(16).padStart(12,'0')
 const id=hex.slice(0,8)+'-'+hex.slice(8)+'-7000-8000-000000000000'
 assert.equal(runningStartedAt({id,startedAt:null,items:[]},observed,now),started)
 assert.equal(runningStartedAt({id:'legacy',items:[{id:'a',startedAtMs:now-42000},{id:'b',startedAtMs:now-63000}]},observed,now),now-63000)
 assert.equal(runningStartedAt({id:'legacy',startedAt:now+100000,items:[]},observed,now),observed)
})
test('late turn start merges timestamps without discarding already received items',()=>{
 const detail={thread:{id:'thread'},turns:[{id:'turn',status:'inProgress',items:[{id:'item',text:'response'}]}]}
 const event={type:'turn/started',threadId:'thread',payload:{turn:{id:'turn',status:'inProgress',startedAt:12345,items:[]}}}
 const next=applyDetailEvent(detail,event)
 assert.equal(next.turns[0].startedAt,12345);assert.equal(next.turns[0].items[0].text,'response')
})
test('item updates retain the original start timestamp when a later event omits it',()=>{
 const detail={thread:{id:'thread'},turns:[{id:'turn',items:[{id:'item',startedAtMs:12345}]}]}
 const next=applyDetailEvent(detail,{type:'item/upsert',threadId:'thread',turnId:'turn',payload:{item:{id:'item',startedAtMs:null}}})
 assert.equal(next.turns[0].items[0].startedAtMs,12345)
})
