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
  const [a,b] = store.wxRows('card','open')
  assert.ok(client.sent[0].text.includes('#' + a.id))
  await receive('ambiguous','允许')
  assert.match(client.sent.at(-1).text,/回复项目名[\s\S]*\na\nb$/)
  assert.equal(responses.length,0)
  await receive('focus','b')
  assert.match(client.sent.at(-1).text,/【需要审批】b/)
  channel.accept({msgs:[inbound('1','允许'),inbound('late','允许')]})
  const [first,late] = store.wxRows('in','pending')
  await channel.handle(first,signal)
  await channel.delivery.flush(signal)
  await channel.handle(late,signal)
  assert.deepEqual(responses.map(r=>r.instanceId),['b'])
  await receive('next','拒绝')
  assert.deepEqual(responses.map(r => [r.instanceId,r.response.decision]),[['b','accept'],['a','decline']])
  assert.equal(admitted.length,0)
})

test('a numbered reply to the visible card applies to that project while another approval waits', async t => {
  const {requests,channel,signal,client,receive,responses,admitted} = await localChannel(t)
  const params = {command:'pwd',cwd:'/aaa',availableDecisions:['accept','cancel']}
  requests.set('aaa',approval('aaa',{params}))
  channel.syncCards()
  await channel.delivery.flush(signal)
  requests.set('bbb',approval('bbb',{params:{...params,cwd:'/bbb'}}))
  channel.syncCards()
  channel.delivery.enqueue('bbb-start','「bbb」的任务已开始执行。')
  await channel.delivery.flush(signal)
  await receive('first','1')
  assert.match(client.sent.at(-1).text,/【需要审批】bbb/)
  const head = channel.queueHead()
  channel.accept({msgs:[inbound('delayed','1',{create_time_ms:head.shownAt - 1000})]})
  await channel.handle(channel.store.wxRows('in','pending')[0],signal)
  assert.equal(responses.length,1)
  await receive('second','2')
  assert.deepEqual(responses.map(r=>[r.instanceId,r.response.decision]),[['aaa','accept'],['bbb','cancel']])
  assert.equal(admitted.length,0)
})

test('a menu reply can only open a listed, still-live card, including duplicate project names', async t => {
  const {requests,channel,store,signal,client,receive,responses,admitted} = await localChannel(t)
  requests.set('a',approval('a',{worker:'aaa · session 1'}))
  requests.set('b',approval('b',{worker:'aaa · session 2'}))
  channel.syncCards()
  await channel.delivery.flush(signal)
  await receive('list','待办')
  await receive('not-a-decision','1')
  await receive('duplicate','aaa')
  const [first,second] = store.wxRows('card','open')
  assert.ok(client.sent.at(-1).text.includes('#' + first.id))
  assert.ok(client.sent.at(-1).text.includes('#' + second.id))
  channel.accept({msgs:[inbound('focus','aaa · session 2'),inbound('late-menu','1')]})
  for (const row of store.wxRows('in','pending')) {
    await channel.handle(row,signal)
    await channel.delivery.flush(signal)
  }
  assert.equal(responses.length,0)
  assert.equal(admitted.length,0)
  assert.match(client.sent.at(-1).text,/列表已切换/)
  await receive('approve','1')
  assert.deepEqual(responses.map(r=>r.instanceId),['b'])
  assert.match(client.sent.at(-1).text,/【需要审批】aaa · session 1/)
})

test('a command offering cancel in place of decline shows and submits that native decision', async t => {
  const {requests,channel,signal,client,receive,responses} = await localChannel(t)
  requests.set('a',approval('a',{params:{command:'pwd',cwd:'/fixture',availableDecisions:['accept','cancel']}}))
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.match(client.sent[0].text,/2 取消/)
  await receive('stop','2')
  assert.deepEqual(responses.map(r=>r.response),[{decision:'cancel'}])
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
  const [first,second] = store.wxRows('card','open')
  await reply('select-first','#' + first.id)
  assert.match(client.sent.at(-1).text,/【需要审批】a/)
  await reply('approve','允许')
  await reply('select-second','#' + second.id)
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
  assert.deepEqual(store.answeredInteractions(responses[0].dispatchId),[{method:'item/tool/requestUserInput',
    choices:[{question:'选择数据库',selected:'SQLite'}]}])
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

test('choice replies match only unique mobile titles; unrelated messages stay on the Router', async t => {
  const { channel, router, store, receive, client, signal, admitted } = await localChannel(t)
  const item = { id:'choose', revision:2, status:'pending', kind:'session', semanticChoice:true,
    expiresAt:Date.now()+60000, label:'very long prompt', candidates:[
      {id:'first',phoneTitle:'Web 界面优化',name:'old prompt', summary:'/internal/repository/long'},
      {id:'second',phoneTitle:'Web 构建',name:'other prompt'}] }
  store.put('clarification', item.id, item)
  const decisions = []
  router.confirm = async (data, cancel) => {
    decisions.push({data,cancel})
    store.put('clarification',item.id,{...item,status:'confirmed'})
  }
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.doesNotMatch(client.sent[0].text,/internal|long prompt|old prompt/)
  await receive('ambiguous','选 Web')
  assert.match(client.sent.at(-1).text,/多个候选/)
  await receive('normal','今天星期几？')
  assert.equal(admitted[0].text,'今天星期几？')
  await receive('pick','Web 界面那个')
  assert.deepEqual(decisions,[{data:{id:'choose',revision:2,candidateId:'first'},cancel:false}])
})

test('a long approval accepts only after the final segment; changed scope requires a fresh presentation', async t => {
  const { channel, requests, store, client, signal, receive, responses } = await localChannel(t)
  const cmd = 'echo ' + 'x'.repeat(4200) + ' END'
  requests.set('long',approval('long',{params:{command:cmd,cwd:'/fixture'}}))
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.equal(channel.queueHead().shown,undefined)
  await receive('early','1')
  assert.equal(responses.length,0)
  while (!channel.queueHead().shown) await channel.delivery.flush(signal)
  assert.ok(client.sent.some(msg=>msg.text.includes(' END')))
  channel.accept({msgs:[inbound('stale','1')]})
  requests.get('long').params.command = 'npm run build'
  await channel.handle(store.wxRows('in','pending')[0],signal)
  await channel.delivery.flush(signal)
  assert.equal(responses.length,0)
  await receive('fresh','1')
  assert.equal(responses.length,1)
})

test('missing file scope cannot be approved; late details replace the same card', async t => {
  const { channel, requests, store, client, signal, receive, responses } = await localChannel(t)
  const request = approval('file',{method:'item/fileChange/requestApproval',params:{reason:'edit'}})
  requests.set('file',request)
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.equal(client.sent.length,0)
  const out = store.wxRows('out','pending')[0]
  store.wxSave('out',{...out,readyAt:0})
  await channel.delivery.flush(signal)
  assert.match(client.sent[0].text,/缺少可核实/)
  await receive('blind','允许')
  assert.equal(responses.length,0)
  const code = channel.queueHead().id
  request.params.changes = [{path:'test.txt',kind:'update'}]
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.match(client.sent.at(-1).text,/test.txt/)
  assert.equal(channel.queueHead().id,code)
  await receive('fresh','1')
  assert.equal(responses[0].instanceId,'file')
})

test('a fresh phone task after an empty handoff queue receives its real card', async t => {
  const {channel,store,signal,receive,client} = await localChannel(t)
  channel.pauseQueue('old-closed-card')
  await receive('new','查找两个测试会话')
  store.put('clarification','read-project',{id:'read-project',kind:'psmAccess',revision:1,requestId:'new',
    status:'pending',expiresAt:Date.now()+60000,label:'允许阅读历史？',candidates:[{id:'aaa',name:'aaa'}]})
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.match(client.sent.at(-1).text,/允许阅读历史[\s\S]*aaa/)
  assert.equal(channel.queueHead().shown,true)
})

test('session selection shows distinguishing facts and discloses the full grant before submission', async t => {
  const {channel,router,store,receive,client,signal} = await localChannel(t)
  const item = {id:'cross-project',revision:1,status:'pending',kind:'session',semanticChoice:true,
    expiresAt:Date.now()+60000,label:'选择测试会话',candidates:['aaa','bbb'].map((name,index)=>({
      id:'thread-'+name,projectId:name,project:name,phoneTitle:'优化方案',phoneSummary:index?'配对回归已验收':'USB HUB 掉线测试已记录',
      pendingProject:{cwd:'/tmp/test/'+name},grant:{settings:{sandbox:{type:'readOnly'},approvalPolicy:'never'}},
      accessNotice:'此处不应重复权限说明',
    }))}
  let selected
  router.confirm = async data => {selected=data}
  store.put('clarification',item.id,item)
  channel.syncCards()
  await channel.delivery.flush(signal)
  assert.match(client.sent[0].text,/aaa · 优化方案 · USB HUB 掉线测试已记录[\s\S]*bbb · 优化方案 · 配对回归已验收/)
  assert.doesNotMatch(client.sent[0].text,/\/tmp\/|免审批|此处不应重复/)
  await receive('pick','第二个')
  assert.equal(selected,undefined)
  assert.match(client.sent.at(-1).text,/已选 bbb[\s\S]*\/tmp\/test\/bbb[\s\S]*只读，免审批[\s\S]*确认授权/)
  await receive('grant','确认授权')
  assert.equal(selected.candidateId,'thread-bbb')
})
