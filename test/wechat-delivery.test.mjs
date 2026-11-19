import assert from 'node:assert/strict'
import test from 'node:test'
import { inbound, localChannel } from './fixtures/wechat.mjs'

test('inbox commits with opaque cursor and only owner direct texts affect context or deduplication', async t => {
  const { channel,store,signal,admitted } = await localChannel(t)
  const msg = inbound('18446744073709551615','hello')
  const batch = {get_updates_buf:'opaque+/=', msgs:[inbound('f','other',{from_user_id:'stranger'}),
    inbound('g','group',{group_id:'group'}),inbound('b','bot',{message_type:2}), msg, msg]}
  store.db.exec("CREATE TRIGGER stop_cursor BEFORE UPDATE ON wechat_records WHEN NEW.kind='binding' BEGIN SELECT RAISE(ABORT,'fixture'); END")
  assert.throws(() => channel.accept(batch), /fixture/)
  assert.equal(store.wxRows('in').length,0)
  assert.equal(channel.account.cursor,'')
  store.db.exec('DROP TRIGGER stop_cursor')
  channel.accept(batch)
  channel.accept(batch)
  assert.equal(channel.account.cursor,'opaque+/=')
  assert.equal(channel.unseal(channel.account.context),msg.context_token)
  assert.equal(store.wxRows('in').length,1)
  await channel.handle(store.wxRows('in','pending')[0],signal)
  assert.equal(admitted.length,1)
  channel.accept({msgs:[inbound(undefined,'unstable')]})
  assert.equal(store.wxRows('in','unknown').length,1)
  assert.doesNotMatch(JSON.stringify(store.wxRows('in')), /hello|unstable|context-1844/)
})

test('mixed receipt batches, rebind and disabled notifications do not forward Web text', async t => {
  const {channel,client,signal,store} = await localChannel(t)
  const task = id => ({id,status:'completed',routerThreadId:'main'})
  channel.preferences({results:false,decisions:true})
  channel.terminal(task('private'),true)
  channel.preferences({results:true,decisions:true})
  channel.terminal(task('public'),true)
  channel.receipt({id:'batch',dispatchIds:['public','private']},'delivered','private task output')
  await channel.delivery.flush(signal)
  assert.deepEqual(client.sent.map(x => x.text),['public：回合已结束。\n暂时没有可核实的结果说明。'])
  channel.receipt({id:'batch',dispatchIds:['public','private']},'delivered','private task output')
  channel.terminal(task('public'),true)
  await channel.delivery.flush(signal)
  assert.equal(client.sent.length,1)
  channel.terminal(task('before-change'),true)
  channel.disconnect(true)
  assert.equal(store.wxRows('out').length,0)
  assert.equal(store.wxRows('binding').length,0)
})

test('a short final answer after a phone choice is delivered once even if the summary doubts the answer', async t => {
  const {channel,store,client,signal} = await localChannel(t)
  store.put('message','wx-action:answer',{dispatchId:'bbb',status:'completed',interactionMethod:'item/tool/requestUserInput'})
  channel.terminal({id:'bbb',routerThreadId:'main',status:'completed',finalReply:'按项目名汇报：bbb。'},true)
  const batch = {id:'report',dispatchIds:['bbb']}
  channel.receipt(batch,'delivered','无法确认用户是否选择了汇报方式。')
  await channel.delivery.flush(signal)
  channel.receipt(batch,'delivered','迟到的重复回执')
  await channel.delivery.flush(signal)
  assert.deepEqual(client.sent.map(m=>m.text),['【任务结果】\n按项目名汇报：bbb。'])
})

test('a confirmed Web answer preserves the Worker result without claiming a missing phone reply', async t => {
  const {channel,store,client,signal} = await localChannel(t)
  const questionId = 'worker-question:bbb:ab'
  const question = {dispatchId:'bbb',questions:[{title:'甲还是乙？',options:['甲','乙']}]}
  store.put('message',questionId,{...question,status:'unknown'})
  assert.deepEqual(store.answeredInteractions('bbb'),[])
  // Legacy Web submissions kept the answered state, without storing any answer text.
  store.put('message',questionId,{...question,status:'answered'})
  assert.deepEqual(store.answeredInteractions('bbb'),[{method:'worker/question'}])
  assert.deepEqual(store.answeredInteractions('aaa'),[])
  channel.terminal({id:'bbb',routerThreadId:'main',status:'completed',finalReply:'你选了「甲」。'},true)
  const batch = {id:'web-first',dispatchIds:['bbb']}
  channel.receipt(batch,'delivered','无法确认选择结果。')
  await channel.delivery.flush(signal)
  assert.deepEqual(client.sent.map(m=>m.text),['【任务结果】\n你选了「甲」。'])
})

test('a late structured answer on an existing dispatch preserves its actual directory reply', async t => {
  const {channel,store,client,signal} = await localChannel(t)
  const id = 'bbb'
  const finalReply = '当前会话的完整目录为 `/tmp/fixture/bbb`。'
  channel.terminal({id,routerThreadId:'main',status:'completed',finalReply},true)
  store.put('message','worker-result:' + id,{text:finalReply})
  // Pre-fix phone records for structured Worker questions had choices but no interactionMethod.
  const choices = [{question:'如何汇报？',selected:'按完整目录'}]
  store.put('message','wx-action:folder',{dispatchId:id,status:'completed',receiptEvidence:{choices}})
  assert.deepEqual(store.answeredInteractions(id),[{method:'worker/question',choices}])
  assert.deepEqual(store.answeredInteractions('aaa'),[])
  const batch = {id:'folder',dispatchIds:[id]}
  channel.receipt(batch,'delivered','服务端记录中没有已提交的原生选项答复。')
  await channel.delivery.flush(signal)
  channel.receipt(batch,'delivered','重复回执')
  await channel.delivery.flush(signal)
  assert.deepEqual(client.sent.map(m=>m.text),['【任务结果】\n' + finalReply])
})

test('typing follows the actual phone turn, is cancelled, and falls back only for a still active turn', async t => {
  const {router,channel,client,store,signal} = await localChannel(t)
  const message = {id:'user:phone',requestId:'phone',routerThreadId:'main',status:'accepted',
    startedAt:Date.now(),origin:{generation:channel.account.generation,inbox:'in'}}
  store.wxSave('in',{id:'in',state:'done',context:channel.seal('context-in')})
  store.put('message',message.id,message)
  const calls = []
  client.typingTicket = async (a,context) => { assert.equal(a,channel.account);assert.equal(context,'context-in');return 'ticket' }
  client.typing = async (a,ticket,status) => { assert.equal(ticket,'ticket');calls.push(status) }
  router.active = message
  channel.progress.tick(signal)
  assert.deepEqual(calls,[])
  message.startedAt -= 4000
  channel.progress.tick(signal)
  await Promise.all([...channel.jobs])
  channel.progress.tick(signal)
  assert.deepEqual(calls,[1])
  router.active = null
  channel.progress.tick(signal)
  await Promise.all([...channel.jobs])
  assert.deepEqual(calls,[1,2])
  assert.equal(store.wxRows('out').length,0)

  router.active = message
  client.typingTicket = async () => { throw Error('unsupported') }
  channel.progress.tick(signal)
  await Promise.all([...channel.jobs])
  await channel.delivery.flush(signal)
  channel.progress.tick(signal)
  await channel.delivery.flush(signal)
  assert.deepEqual(client.sent.map(row=>row.text),['我正在处理这条消息。'])
  router.active = null
  channel.progress.tick(signal)
})

test('slow phone turns refresh every five seconds and handoff cancels an in-flight refresh in order', async t => {
  const {router,channel,client,store,signal} = await localChannel(t)
  t.mock.timers.enable({apis:['Date'],now:Date.now()})
  router.active = {id:'phone',requestId:'phone',routerThreadId:'main',status:'accepted',startedAt:Date.now()-3000,
    origin:{generation:channel.account.generation,inbox:'in'}}
  store.wxSave('in',{id:'in',state:'done',context:channel.seal('private-context')})
  let tickets = 0, release
  const calls = []
  client.typingTicket = async () => {tickets++;return 'private-ticket'}
  client.typing = async (_account,_ticket,command) => {
    calls.push(command)
    if (calls.length === 2) await new Promise(resolve=>{release=resolve})
  }
  channel.progress.tick(signal)
  await Promise.all([...channel.jobs])
  t.mock.timers.tick(4999)
  channel.progress.tick(signal)
  assert.deepEqual(calls,[1])
  t.mock.timers.tick(1)
  channel.progress.tick(signal)
  router.active.handedOff = true
  channel.progress.tick(signal)
  t.mock.timers.tick(15000)
  channel.progress.tick(signal)
  assert.deepEqual(calls,[1,1])
  release()
  await Promise.all([...channel.jobs])
  channel.progress.tick(signal)
  assert.deepEqual(calls,[1,1,2])
  assert.equal(tickets,1)
  assert.equal(store.wxRows('out').length,0)
  const evidence = store.wxRead('in','in').typing
  assert.deepEqual(Object.keys(evidence),['ticket','start','refresh','stop'])
  assert.equal(evidence.stop.outcome,'acknowledged')
  assert.doesNotMatch(JSON.stringify(evidence),/private/)
})

test('a successful cancellation preserves an unconfirmed start and a single text fallback', async t => {
  const {router,channel,client,store,signal} = await localChannel(t)
  router.active = {id:'user:phone',requestId:'phone',routerThreadId:'main',status:'accepted',startedAt:Date.now()-5000,
    origin:{generation:channel.account.generation,inbox:'in'}}
  store.put('message',router.active.id,router.active)
  store.wxSave('in',{id:'in',state:'done',context:channel.seal('private-context')})
  client.typingTicket = async () => 'private-ticket'
  client.typing = async (_account,_ticket,command) => {if(command===1) throw Error('upstream secret')}
  channel.progress.tick(signal)
  await Promise.all([...channel.jobs])
  await channel.delivery.flush(signal)
  router.active = null
  channel.progress.tick(signal)
  await Promise.all([...channel.jobs])
  const evidence = store.wxRead('in','in').typing
  assert.equal(evidence.start.outcome,'unconfirmed')
  assert.equal(evidence.stop.outcome,'acknowledged')
  assert.doesNotMatch(JSON.stringify(evidence),/secret|private/)
  assert.deepEqual(client.sent.map(m=>m.text),['我正在处理这条消息。'])
})

test('delayed typing tickets never start typing after an answer, and worker progress is derived and deduplicated', async t => {
  const {router,channel,client,store,signal} = await localChannel(t)
  const message = {id:'user:work',requestId:'work',routerThreadId:'main',status:'accepted',startedAt:Date.now()-20000,
    origin:{generation:channel.account.generation,inbox:'in'}}
  store.wxSave('in',{id:'in',state:'done',context:channel.seal('context-in')})
  store.put('message',message.id,message)
  let release
  client.typingTicket = () => new Promise(resolve=>{ release=resolve })
  client.typing = () => assert.fail('late typing must not be sent')
  router.active = message
  channel.progress.tick(signal)
  router.active = null
  release('late')
  await Promise.all([...channel.jobs])
  channel.progress.tick(signal)
  router.projects = new Map([['test',{name:'测试项目'}]])
  const task = {id:'task',requestId:'work',routerThreadId:'main',projectId:'test',status:'queued',createdAt:Date.now()-20000}
  store.put('task',task.id,task)
  channel.progress.worker({id:task.id,type:'task.queued'})
  await channel.delivery.flush(signal)
  store.put('task',task.id,{...task,status:'running',turnId:'turn'})
  channel.progress.worker({id:task.id,type:'task.started'})
  await channel.delivery.flush(signal)
  channel.progress.worker({id:task.id,type:'task.started'})
  await channel.delivery.flush(signal)
  assert.deepEqual(client.sent.map(m=>m.text),['「测试项目」的任务已排队。','「测试项目」的任务已开始执行。'])
  store.put('task','fast',{...task,id:'fast',status:'queued'})
  channel.progress.worker({id:'fast',type:'task.queued'})
  store.put('task','fast',{...task,id:'fast',status:'completed'})
  await channel.delivery.flush(signal)
  assert.equal(client.sent.length,2)
})

test('a twenty-minute Worker run has one start notice, no typing heartbeat and one terminal delivery', async t => {
  const {router,channel,client,store,signal} = await localChannel(t)
  t.mock.timers.enable({apis:['Date'],now:Date.now()})
  const m = {id:'user:long',requestId:'long',routerThreadId:'main',status:'completed',
    origin:{generation:channel.account.generation,inbox:'in'}}
  store.put('message',m.id,m)
  store.wxSave('in',{id:'in',state:'done',context:channel.seal('context-in')})
  router.projects = new Map([['test',{name:'测试项目'}]])
  const task = {id:'long-task',requestId:'long',projectId:'test',routerThreadId:'main',turnId:'long-turn',status:'running',createdAt:Date.now()}
  store.put('task',task.id,task)
  client.typingTicket = async () => assert.fail('Worker execution cannot type as the Router')
  for(let minute=0;minute<=20;minute++) {
    channel.progress.worker({id:task.id,type:'task.started'})
    channel.progress.tick(signal)
    await channel.delivery.flush(signal)
    t.mock.timers.tick(60000)
  }
  const done = {...task,status:'completed',finalReply:'已完成只读检查。'}
  store.put('task',task.id,done)
  channel.terminal(done,true)
  channel.receipt({id:'receipt',dispatchIds:[task.id]},'delivered','已完成只读检查。')
  await channel.delivery.flush(signal)
  assert.deepEqual(client.sent.map(m=>m.text),['「测试项目」的任务已开始执行。','【任务结果】\n已完成只读检查。'])
})

test('unknown transmission is never retried; proven retry reuses its client ID; sending at crash becomes unknown', async t => {
  const {channel,client,signal,store} = await localChannel(t)
  channel.delivery.enqueue('notice','text')
  const ids = []
  client.send = async (_account,payload) => { ids.push(payload.clientId); throw Object.assign(Error(),{disposition:'retry'}) }
  await channel.delivery.flush(signal)
  const retry = store.wxRead('out','notice')
  assert.equal(retry.state,'pending')
  store.wxSave('out',{...retry,readyAt:0})
  client.send = async (_account,payload) => { ids.push(payload.clientId); throw Error('lost reply') }
  await channel.delivery.flush(signal)
  await channel.delivery.flush(signal)
  assert.equal(store.wxRead('out','notice').state,'unknown')
  assert.deepEqual(ids,[retry.clientId,retry.clientId])
  store.wxSave('out',{...retry,id:'crashed',state:'sending'})
  channel.recover()
  assert.equal(store.wxRead('out','crashed').state,'unknown')
})

test('rejected deliveries keep safe diagnostics and stay closed on the next flush', async t => {
  const {channel,client,signal,store} = await localChannel(t)
  let attempts = 0
  for (const code of [-200, 'private upstream text']) {
    channel.delivery.enqueue('notice' + attempts,'text')
    client.send = async () => { attempts++; throw Object.assign(Error('private upstream text'),{code,disposition:'rejected'}) }
    await channel.delivery.flush(signal)
    const record = store.wxRead('out','notice' + (attempts - 1))
    assert.equal(record.state,'failed')
    assert.equal(record.errorCode,code === -200 ? -200 : 'unknown')
    assert.ok(record.errorAt > 0)
    assert.doesNotMatch(JSON.stringify(record),/private upstream text/)
  }
  await channel.delivery.flush(signal)
  assert.equal(attempts,2)
})

test('no startup context holds results; direct reply retains the originating message context', async t => {
  const {channel,client,signal,store} = await localChannel(t)
  delete channel.account.context
  channel.terminal({id:'task',routerThreadId:'main',status:'failed'},false)
  await channel.delivery.flush(signal)
  assert.equal(client.sent.length,0)
  channel.accept({msgs:[inbound('one','hello'),inbound('two','later')]})
  const first = store.wxRows('in')[0]
  channel.delivery.enqueue('reply','direct',{inbox:first.id})
  await channel.delivery.flush(signal)
  assert.deepEqual(client.sent.map(m=>m.context),['context-two','context-one'])
})

test('late old poll and send callbacks cannot repopulate a removed binding', async t => {
  const {channel,client,store} = await localChannel(t)
  let releasePoll, releaseSend
  client.updates = () => new Promise(resolve => { releasePoll = resolve })
  client.send = () => new Promise(resolve => { releaseSend = resolve })
  channel.delivery.enqueue('old','private reply')
  channel.startPolling()
  assert.ok(releasePoll && releaseSend)
  channel.disconnect(true)
  releasePoll({get_updates_buf:'old-cursor',msgs:[inbound('old','late input')]})
  releaseSend({message_id:'late-ack'})
  await Promise.all([...channel.jobs])
  assert.equal(channel.phase,'unbound')
  assert.equal(store.wxRows('in').length,0)
  assert.equal(store.wxRows('out').length,0)
  assert.equal(store.wxRows('binding').length,0)
})
