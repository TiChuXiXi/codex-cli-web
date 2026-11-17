import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {transform} from 'esbuild'
import {EventBus} from '../server/services/events.js'

const {code}=await transform(await readFile(new URL('../web/src/utils.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'})
const {applyDetailEvent,isCompacting}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))
test('compaction stays pending until completion, including history reload and replay',()=>{
 const started={id:'compaction',type:'contextCompaction',startedAtMs:12345,streaming:true}
 let detail={thread:{id:'thread'},turns:[{id:'turn',status:'inProgress',items:[]}]}
 const event={type:'item/upsert',threadId:'thread',turnId:'turn',payload:{item:started}}
 detail=applyDetailEvent(detail,event)
 assert.equal(isCompacting(detail.turns[0].items[0]),true)
 // A refreshed history snapshot has timestamps but no streaming marker.
 assert.equal(isCompacting({id:started.id,type:started.type,startedAtMs:12345,completedAtMs:null}),true)
 detail=applyDetailEvent(detail,{...event,payload:{item:{id:started.id,type:started.type,completedAtMs:54321},completed:true}})
 assert.equal(detail.turns[0].items[0].startedAtMs,12345)
 assert.equal(isCompacting(detail.turns[0].items[0]),false)
 detail=applyDetailEvent(detail,event)
 assert.equal(isCompacting(detail.turns[0].items[0]),false)
 assert.equal(isCompacting({id:started.id,type:started.type,startedAtMs:12345,completedAtMs:54321}),false)
 // Legacy history without lifecycle metadata retains its completed label.
 assert.equal(isCompacting({id:started.id,type:started.type}),false)
 assert.equal(isCompacting({...started,streaming:false}),false)
})

const meta={threadId:'thread',turnId:'turn',itemId:'message'}
const initial=()=>({thread:{id:'thread'},turns:[{id:'turn',status:'inProgress',items:[{id:'message',type:'agentMessage',text:'',streaming:true}]}]})
const text=detail=>detail.turns[0].items[0].text
const delta=value=>({type:'item/delta',...meta,channel:'agentMessage',payload:{delta:value}})
const complete=value=>({type:'item/upsert',...meta,payload:{item:{id:'message',type:'agentMessage',text:value},completed:true}})

test('a completed full message follows buffered deltas and replay preserves exact text',()=>{
 const bus=new EventBus(),seen=[]
 let detail=initial()
 bus.subscribe(event=>{seen.push(event);detail=applyDetailEvent(detail,event)})
 const full='检查确认，消息间距修复已经在远程 main 上；本次只需提交并推送 AGENTS.md。'
 bus.publishDelta('message','检查确认，消息间距修复已经在远程 ',{...meta,channel:'agentMessage'})
 bus.publishDelta('message','main 上；本次只需提交并推送 AGENTS.md。',{...meta,channel:'agentMessage'})
 bus.publish('item/upsert',complete(full).payload,meta)
 bus.flushDeltas()
 assert.deepEqual(seen.map(event=>event.type),['item/delta','item/upsert'])
 assert.equal(text(detail),full)
 const replay=bus.since(0).reduce(applyDetailEvent,initial())
 assert.equal(text(replay),full)
 bus.dispose()
})

test('late deltas and replayed starts cannot append to or reopen a finalized item',()=>{
 let detail=applyDetailEvent(initial(),complete('完整回复'))
 detail=applyDetailEvent(detail,delta('回复'))
 detail=applyDetailEvent(detail,{type:'item/upsert',...meta,payload:{item:{id:'message',type:'agentMessage',text:'',streaming:true}}})
 detail=applyDetailEvent(detail,delta('回复'))
 assert.equal(text(detail),'完整回复')
 assert.equal(detail.turns[0].items[0].streaming,false)
 // Full authoritative snapshots still replace the text.
 assert.equal(text(applyDetailEvent(detail,complete('更正后的完整回复'))),'更正后的完整回复')
})

test('history loaded for a finished turn ignores replayed text while active repeated text remains intact',()=>{
 const history=initial()
 history.turns[0].status='completed'
 history.turns[0].items[0]={id:'message',type:'agentMessage',text:'历史全文'}
 assert.equal(text(applyDetailEvent(history,delta('全文'))),'历史全文')
 let active=applyDetailEvent(initial(),delta('哈哈'))
 active=applyDetailEvent(active,delta('哈哈'))
 assert.equal(text(active),'哈哈哈哈')
})

test('completion flushes pending deltas for every channel and thread before snapshots',()=>{
 const bus=new EventBus(),seen=[]
 bus.subscribe(event=>seen.push(event))
 for(const channel of ['agentMessage','commandOutput','reasoningSummary','plan']) {
  bus.publishDelta(channel,channel,{...meta,channel})
 }
 bus.publish('turn/completed',{turn:{id:'turn',status:'completed'}},meta)
 assert.deepEqual(seen.map(event=>event.type),['item/delta','item/delta','item/delta','item/delta','turn/completed'])
 assert.deepEqual(seen.map(event=>event.seq),[1,2,3,4,5])
 bus.dispose()
})
