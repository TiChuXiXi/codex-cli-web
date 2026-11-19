import assert from 'node:assert/strict'
import test from 'node:test'
import { ILinkClient, apiBase, loginBase, parseMessageJson } from '../server/channels/wechat/ilink.js'
import { confirmed, localChannel, until } from './fixtures/wechat.mjs'

test('fixed QR host, self bind and PIN headers, bearer posts, exact opaque cursor and uint64 IDs', async () => {
  const calls = []
  const ilink = new ILinkClient(async (url, options) => {
    calls.push({ url, ...options })
    return new Response('{"ret":0,"message_id":18446744073709551615}')
  })
  const account = { owner: 'owner', base: loginBase, token: 'secret' }
  await ilink.qr()
  await ilink.qrStatus(loginBase,'a&b','012345')
  await ilink.updates(account,'/a+=',35000)
  const response = await ilink.send(account,{ text:'hello',context:'a',clientId:'fixed' })
  assert.equal(response.message_id,'18446744073709551615')
  assert.equal(parseMessageJson('{"msg_id":9007199254740993,"text":"message_id:123"}').msg_id,'9007199254740993')
  assert.equal(calls[0].url, loginBase + '/ilink/bot/get_bot_qrcode?bot_type=3')
  assert.deepEqual(JSON.parse(calls[0].body), { local_token_list: [] })
  assert.equal(calls[0].headers.Authorization, undefined)
  assert.equal(calls[1].url, loginBase + '/ilink/bot/get_qrcode_status?qrcode=a%26b&verify_code=012345')
  assert.equal(calls[1].headers['X-WECHAT-UIN'], undefined)
  assert.equal(calls[2].headers.Authorization,'Bearer secret')
  assert.equal(calls[2].headers.AuthorizationType,'ilink_bot_token')
  assert.equal(calls[2].headers['iLink-App-Id'],'bot')
  assert.equal(JSON.parse(calls[2].body).get_updates_buf,'/a+=')
  assert.equal(JSON.parse(calls[3].body).msg.client_id,'fixed')
  assert.equal(JSON.parse(calls[3].body).msg.context_token,'a')
  await ilink.typingTicket(account,'opaque-context')
  await ilink.typing(account,'opaque-ticket',1)
  await ilink.typing(account,'opaque-ticket',2)
  const empty = new ILinkClient(async()=>new Response(null,{status:204}))
  await empty.typing(account,'opaque-ticket',2)
  await assert.rejects(empty.send(account,{text:'x',context:'c',clientId:'id'}))
  assert.deepEqual(calls.slice(4).map(c=>new URL(c.url).pathname),['/ilink/bot/getconfig','/ilink/bot/sendtyping','/ilink/bot/sendtyping'])
  assert.equal(JSON.parse(calls[4].body).context_token,'opaque-context')
  assert.deepEqual(calls.slice(5).map(c=>{const b=JSON.parse(c.body);return [b.ilink_user_id,b.typing_ticket,b.status]}),
    [['owner','opaque-ticket',1],['owner','opaque-ticket',2]])
  for (const link of ['http://ilinkai.weixin.qq.com','https://weixin.qq.com.evil.invalid','https://name@weixin.qq.com']) assert.throws(() => apiBase(link))
})

test('network ambiguity, refusal before connect, rate limit and stale token are distinct', async () => {
  const refused = new ILinkClient(async()=>new Response('{"ret":-1,"errcode":-200}'))
  await assert.rejects(refused.qr(),error => error.code === -200 && error.disposition === 'rejected')
  for (const [result, type] of [[new Response('{}',{status:429}),'retry'], [new Response('{}',{status:502}),'unknown'],
    [new Response('{"errcode":-14}'),'rejected'], [new TypeError('network',{cause:{code:'ECONNREFUSED'}}),'retry']]) {
    const ilink = new ILinkClient(async () => { if (result instanceof Error) throw result; return result })
    await assert.rejects(ilink.qr(), e => e.disposition === type)
  }
})

test('QR polling follows verified redirect, refreshes expired QR, accepts PIN only for this login, and expires on -14', async t => {
  const { channel, client } = await localChannel(t)
  channel.disconnect(true)
  let count = 0
  client.qrStatus = async (base, qr, pin) => {
    switch (++count) {
      case 1: return { status:'expired' }
      case 2: return { status:'scaned_but_redirect',redirect_host:'ilinkai.weixin.qq.com' }
      case 3: return { status:'need_verifycode' }
      case 4: assert.equal(pin,'1234'); return { status:'scaned' }
      default: assert.equal(pin,''); return confirmed
    }
  }
  client.updates = async () => { throw Object.assign(Error(), {code:-14}) }
  const { loginId } = channel.bind()
  await until(() => channel.phase === 'waiting_pin')
  assert.throws(() => channel.pin({loginId:'old',pin:'1234'}))
  channel.pin({loginId,pin:'1234'})
  await until(() => channel.phase === 'expired')
  const status = channel.status()
  assert.equal(status.results && status.decisions,true)
  assert.equal(status.canNotify,false)
  assert.doesNotMatch(JSON.stringify(status),/fixture-private-token|owner@im.wechat|1234/)
})

test('cancelled login cannot bind from a late confirmed response', async t => {
  const { channel, client } = await localChannel(t)
  channel.disconnect(true)
  let finish
  client.qrStatus = () => new Promise(resolve => { finish = resolve })
  channel.bind()
  await until(() => finish)
  channel.disconnect(true)
  finish(confirmed)
  await until(() => channel.jobs.size === 0)
  assert.equal(channel.account,null)
  assert.equal(channel.status().phase,'unbound')
})
