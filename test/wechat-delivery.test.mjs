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
  assert.deepEqual(client.sent.map(x => x.text),['public：回合已结束。详细记录已保存在工作台。'])
  channel.receipt({id:'batch',dispatchIds:['public','private']},'delivered','private task output')
  channel.terminal(task('public'),true)
  await channel.delivery.flush(signal)
  assert.equal(client.sent.length,1)
  channel.terminal(task('before-change'),true)
  channel.disconnect(true)
  assert.equal(store.wxRows('out').length,0)
  assert.equal(store.wxRows('binding').length,0)
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
