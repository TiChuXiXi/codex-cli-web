import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WeChatChannel } from '../../server/channels/wechat/channel.js'
import { RouterStore } from '../../server/router/store.js'

export async function until(check) {
  for (let i = 0; i < 150; i++) {
    const value = check()
    if (value) return value
    await delay(20)
  }
  assert.fail('fixture condition timed out: ' + check)
}

export const confirmed = { status: 'confirmed', ilink_user_id: 'owner@im.wechat', ilink_bot_id: 'bot',
  bot_token: 'fixture-private-token', baseurl: 'https://ilinkai.weixin.qq.com' }
export function inbound(id, text, extra = {}) {
  return { message_id: id, message_type: 1, from_user_id: confirmed.ilink_user_id, to_user_id: 'bot',
    context_token: 'context-' + id, item_list: [{ type: 1, text_item: { text } }], ...extra }
}

export function fakeClient() {
  return { sent: [], qr: async () => ({ qrcode: 'handle', qrcode_img_content: 'https://example.invalid/fixture' }),
    qrStatus: async () => confirmed,
    updates: (_a, _c, _t, signal) => delay(60000, {}, { signal }),
    async send(account, message) { this.sent.push({ ...message, to: account.owner }); return { ret: 0, message_id: String(this.sent.length) } },
  }
}

export async function localChannel(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-test-'))
  const store = new RouterStore(join(directory,'router.sqlite'))
  const requests = new Map()
  const responses = []
  const admitted = []
  const router = { directory, store, session: { id: 'main' }, phase: 'ready',
    dispatcher: { interactions: () => [...requests.values()], workerLabel: task => task.id },
    respond(payload) {
      const request = requests.get(payload.instanceId)
      assert.equal(request?.dispatchId, payload.dispatchId)
      requests.delete(payload.instanceId)
      responses.push(payload)
    },
    publish() {}, kickInputs() {}, admit(data) { admitted.push(data) } }
  const client = fakeClient()
  const channel = new WeChatChannel(router, client)
  router.wechat = channel
  t.after(async () => { await channel.close(); store.close(); await rm(directory, { recursive: true, force: true }) })
  channel.account = { generation: 'bound-fixture', owner: confirmed.ilink_user_id, token: confirmed.bot_token,
    bot: 'bot', base: confirmed.baseurl, results: true, decisions: true, cursor: '', context: channel.seal('owner-context') }
  channel.saveAccount()
  const signal = new AbortController().signal
  async function receive(id, text) {
    channel.accept({ msgs: [inbound(id,text)], get_updates_buf: id })
    for (const row of store.wxRows('in','pending')) await channel.handle(row,signal)
    await channel.delivery.flush(signal)
  }
  return { channel, router, store, client, requests, responses, admitted, signal, receive }
}
