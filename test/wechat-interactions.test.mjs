import assert from 'node:assert/strict'
import test from 'node:test'
import { inbound, localChannel } from './fixtures/wechat.mjs'
import { WeChatChannel } from '../server/channels/wechat/channel.js'

const approval = (id, overrides={}) => ({ instanceId: id, requestId:7, dispatchId:'dispatch-'+id, worker:id,
  method:'item/commandExecution/requestApproval', params:{command:'npm run build',cwd:'/fixture',reason:'compile'}, ...overrides })

test('parallel approvals present one prompt at a time and a delayed answer cannot authorize the next', async t => {
  const {requests,channel,client,signal,store,receive,responses,admitted} = await localChannel(t)
  requests.set('a',approval('a')); requests.set('b',approval('b'))
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.match(client.sent[0].text,/npm run build[\s\S]*\/fixture/)
  assert.equal(client.sent.length,1)
  assert.doesNotMatch(client.sent[0].text, /#[A-F0-9]{8}/)
  channel.accept({msgs:[inbound('1','允许'), inbound('late','允许')]})
  const [first,late] = store.wxRows('in','pending')
  await channel.handle(first,signal)
  await channel.delivery.flush(signal)
  assert.match(client.sent.at(-1).text,/【需要审批】b/)
  await channel.handle(late,signal)
  await receive('next','拒绝')
  await receive('next','拒绝')
  assert.deepEqual(responses.map(r => [r.instanceId,r.response.decision]),[['a','accept'],['b','decline']])
  assert.equal(admitted.length,0)
})

test('a sole delivered native request accepts a simple decision; stale unshown cards cannot authorize', async t => {
  const {requests,channel,signal,receive,responses} = await localChannel(t)
  requests.set('a',approval('a'))
  channel.syncCards()
  await receive('1','允许')
  assert.equal(responses.length,0)
  await channel.delivery.flush(signal)
  await receive('2','允许')
  assert.equal(responses[0].instanceId,'a')
})

const colorQuestion = () => approval('color',{dispatchId:'dispatch-a',method:'item/tool/requestUserInput',
  params:{questions:[{id:'color',question:'请选择验收颜色',options:[{label:'松绿'},{label:'靛蓝'}]}]}})

for (const [answer, expected] of [['1','松绿'], ['靛蓝','靛蓝']]) {
  test('the next question accepts ' + answer + ' after the owner answered the preceding approval', async t => {
    const {requests,channel,client,signal,receive,responses} = await localChannel(t)
    requests.set('a',approval('a'))
    channel.syncCards()
    await channel.delivery.flush(signal)
    await receive('approval','1')
    requests.set('color',colorQuestion())
    channel.syncCards()
    await channel.delivery.flush(signal)
    const prompt = client.sent.at(-1).text
    await receive('answer',answer)
    assert.deepEqual(responses.map(r => r.response),[{decision:'accept'},{answers:{color:{answers:[expected]}}}])
    assert.match(prompt,/直接回复选项序号或名称/)
  })
}

test('external resolution requires a handoff before the next prompt accepts a reply', async t => {
  const {requests,channel,client,signal,receive,responses} = await localChannel(t)
  requests.set('a',approval('a'))
  channel.syncCards()
  await channel.delivery.flush(signal)
  requests.delete('a')
  requests.set('color',colorQuestion())
  channel.syncCards()
  await channel.delivery.flush(signal)
  await receive('ambiguous','1')
  assert.equal(responses.length,0)
  assert.match(client.sent.at(-1).text,/继续/)
  await receive('resume','继续')
  assert.match(client.sent.at(-1).text,/请选择验收颜色/)
  await receive('answer','1')
  assert.equal(responses[0].instanceId,'color')
})

test('deferred approvals and free-text questions keep their order and survive restart', async t => {
  const {requests,router,channel,client,signal,receive,responses,admitted,store} = await localChannel(t)
  requests.set('a',approval('a'))
  requests.set('color',colorQuestion())
  requests.set('text',approval('text',{method:'item/tool/requestUserInput',params:{
    questions:[{id:'note',question:'输入验收备注'}]}}))
  channel.syncCards()
  await channel.delivery.flush(signal)
  await receive('skip1','下一个')
  assert.match(client.sent.at(-1).text,/请选择验收颜色/)
  await receive('skip2','暂不处理')
  assert.match(client.sent.at(-1).text,/输入验收备注/)
  await receive('new-task','任务：另一个任务')
  assert.deepEqual(admitted.map(x => x.text),['另一个任务'])
  await receive('text-answer','验收备注正文')
  assert.deepEqual(responses.map(r => r.response),[{answers:{note:{answers:['验收备注正文']}}}])
  assert.equal(channel.queueHead(),undefined)
  // Reopen the persisted binding without starting an independent poller.
  channel.saveAccount({...channel.account, paused:'disconnected'})
  const resumed = new WeChatChannel(router,client)
  resumed.account.paused = null
  async function reply(id, text) {
    resumed.accept({msgs:[inbound(id,text)]})
    for (const row of store.wxRows('in','pending')) await resumed.handle(row,signal)
    await resumed.delivery.flush(signal)
  }
  await reply('return','待办')
  assert.match(client.sent.at(-1).text,/【需要审批】a/)
  await reply('approve','允许')
  assert.match(client.sent.at(-1).text,/请选择验收颜色/)
  await reply('pick','2')
  assert.deepEqual(responses.map(r => r.instanceId),['text','a','color'])
  assert.equal(responses.at(-1).response.answers.color.answers[0],'靛蓝')
  assert.equal(admitted.length,1)
  await resumed.close()
})

test('multi-question native input encrypts a private partial answer, then submits original question IDs once', async t => {
  const {requests,channel,client,signal,store,receive,responses,admitted} = await localChannel(t)
  requests.set('input',approval('input',{method:'item/tool/requestUserInput',params:{questions:[
    {id:'password',question:'测试口令',isSecret:true},
    {id:'db',question:'选择数据库',options:[{label:'SQLite'},{label:'PostgreSQL'}]},
  ]}}))
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.match(client.sent[0].text,/微信聊天会保留/)
  const {id} = store.wxRows('card','open')[0]
  await receive('1','mock-secret')
  assert.equal(responses.length,0)
  assert.doesNotMatch(JSON.stringify(store.wxRows('card')), /mock-secret/)
  await receive('2','1')
  assert.deepEqual(responses[0].response.answers,{password:{answers:['mock-secret']},db:{answers:['SQLite']}})
  assert.equal(store.wxRead('card',id).values,null)
  assert.equal(admitted.length,0)
  const db = store.db.prepare('SELECT data FROM wechat_records UNION ALL SELECT value FROM router_records').all()
  assert.doesNotMatch(JSON.stringify(db),/mock-secret/)
})

test('an expired input clears encrypted partial answers and queued cards are checked before transmission', async t => {
  const {requests,channel,client,signal,store} = await localChannel(t)
  requests.set('gone',approval('gone'))
  channel.syncCards()
  const card = store.wxRows('card','open')[0]
  store.wxSave('card',{...card,values:channel.seal(['mock-secret'])})
  requests.clear()
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.equal(client.sent.length,0)
  assert.equal(store.wxRead('card',card.id).values,null)
})

test('direct reply and proactive Worker request fold into one addressed card, including when Web wins before delivery', async t => {
  const {channel,requests,signal,client,store} = await localChannel(t)
  requests.set('native',approval('native'))
  const requestId = 'wx-direct-request'
  store.put('dispatch-key',requestId,{id:'dispatch-native'})
  store.wxSave('in',{id:'origin',state:'done',context:channel.seal('original-context')})
  channel.syncCards()
  channel.reply({requestId,status:'completed',origin:{inbox:'origin',generation:channel.account.generation}},'任务已派发')
  await channel.delivery.flush(signal)
  assert.equal(client.sent.length,1)
  assert.equal(client.sent[0].context,'original-context')
  assert.match(client.sent[0].text,/任务已派发[\s\S]*npm run build/)
  channel.reply({requestId,status:'completed',origin:{inbox:'origin',generation:channel.account.generation}},'任务已派发')
  await channel.delivery.flush(signal)
  assert.equal(client.sent.length,1)
  requests.clear()
  channel.syncCards()
  requests.set('next',approval('next'))
  store.put('dispatch-key','another',{id:'dispatch-next'})
  store.wxSave('in',{id:'another',state:'done',context:channel.seal('second-context')})
  channel.reply({requestId:'another',status:'completed',origin:{generation:channel.account.generation,inbox:'another'}},'新的待办')
  requests.clear()
  await channel.delivery.flush(signal)
  await channel.delivery.flush(signal)
  assert.match(client.sent.at(-1).text,/已处理或失效/)
  assert.equal(client.sent.at(-1).context,'second-context')
})

test('a choice made in the worker page cannot turn a late private answer into a Router message', async t => {
  const {channel,requests,signal,receive,admitted} = await localChannel(t)
  requests.set('private',approval('private',{method:'item/tool/requestUserInput',
    params:{questions:[{id:'secret',question:'测试私密输入',isSecret:true}]}}))
  channel.syncCards()
  await channel.delivery.flush(signal)
  requests.clear()  // Web won before the next channel reconciliation.
  await receive('late','mock-delayed-private-value')
  assert.equal(admitted.length,0)
  await receive('new','任务：继续新的项目')
  assert.deepEqual(admitted.map(m=>m.text),['继续新的项目'])
})

test('native permission scope and MCP refusal use method-specific response shapes', async t => {
  const {requests,channel,signal,store,receive,responses} = await localChannel(t)
  const permissions = {fileSystem:{write:['/fixture']}}
  requests.set('perms',approval('perms',{method:'item/permissions/requestApproval',params:{permissions}}))
  requests.set('mcp',approval('mcp',{method:'mcpServer/elicitation/request',params:{message:'fixture prompt'}}))
  channel.syncCards()
  await channel.delivery.flush(signal)
  for (const card of store.wxRows('card','open')) {
    const value = card.key === 'native:perms' ? '允许' : '取消'
    await receive(card.id,'#'+card.id+' '+value)
  }
  assert.deepEqual(responses.map(r=>r.response),[{permissions,scope:'turn'},{action:'cancel',content:null,_meta:null}])
})
