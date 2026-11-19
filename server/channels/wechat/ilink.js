import { randomBytes } from 'node:crypto'

const loginBase = 'https://ilinkai.weixin.qq.com'
const version = '3.0.0-beta-0'
const baseInfo = { channel_version: version + '/codex-cli-web', bot_agent: 'codex-cli-web/0.1.0' }

export function apiBase(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/(^|\.)weixin\.qq\.com$/.test(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('微信返回了无效的服务地址')
  }
  return url.origin
}

export class ILinkError extends Error {
  constructor(code, disposition = 'unknown') {
    super('微信请求失败')
    this.code = code
    this.disposition = disposition
  }
}

export function parseMessageJson(text) {
  return JSON.parse(text, (key, value, context) =>
    ['message_id', 'msg_id', 'svr_id'].includes(key) && typeof value === 'number' ? context.source : value)
}

export class ILinkClient {
  constructor(fetchImpl = fetch) { this.fetch = fetchImpl }

  async request(base, path, { body, token, signal, timeout = 15000, allowEmpty = false } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(3 << 16) }
    if (body) Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') })
    if (token) headers.Authorization = 'Bearer ' + token
    const deadline = AbortSignal.timeout(timeout)
    let response
    try {
      response = await this.fetch(apiBase(base) + '/ilink/bot/' + path, {
        method: body ? 'POST' : 'GET', headers, redirect: 'error',
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      const code = error.cause?.code
      throw new ILinkError(deadline.aborted ? 'timeout' : 'network',
        ['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT'].includes(code) ? 'retry' : 'unknown')
    }
    if (!response.ok) throw new ILinkError(response.status, response.status === 429 ? 'retry' :
      [400,401,403,404].includes(response.status) ? 'rejected' : 'unknown')
    const raw = await response.text()
    if (allowEmpty && !raw.trim()) return {}
    let result
    try { result = parseMessageJson(raw) }
    catch { throw new ILinkError('invalid-response') }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ILinkError('invalid-response')
    if ([result.ret, result.errcode].includes(-14)) throw new ILinkError(-14, 'rejected')
    for (const code of [result.errcode, result.ret]) {
      if (code !== undefined && code !== 0) throw new ILinkError(code, 'rejected')
    }
    return result
  }

  qr(signal, previousToken) { return this.request(loginBase, 'get_bot_qrcode?bot_type=3', {
    body: { local_token_list: previousToken ? [previousToken] : [] }, signal }) }
  qrStatus(base, qr, pin, signal) {
    const query = new URLSearchParams({ qrcode: qr })
    if (pin) query.set('verify_code', pin)
    return this.request(base, 'get_qrcode_status?' + query, { signal, timeout: 35000 })
  }
  updates(account, cursor, timeout, signal) {
    return this.request(account.base, 'getupdates', { token: account.token, signal, timeout,
      body: { get_updates_buf: cursor, base_info: baseInfo } })
  }
  async typingTicket(account, context, signal) {
    const result = await this.request(account.base, 'getconfig', { token: account.token, signal, timeout: 3500,
      body: { ilink_user_id: account.owner, context_token: context, base_info: baseInfo } })
    return typeof result.typing_ticket === 'string' ? result.typing_ticket : null
  }
  typing(account, ticket, status, signal) {
    return this.request(account.base, 'sendtyping', { token: account.token, signal, timeout: 3500, allowEmpty:true,
      body: { ilink_user_id: account.owner, typing_ticket: ticket, status, base_info: baseInfo } })
  }
  send(account, { clientId, context, text }, signal) {
    return this.request(account.base, 'sendmessage', { token: account.token, signal, body: {
      base_info: baseInfo, msg: { from_user_id: '', to_user_id: account.owner, client_id: clientId,
        message_type: 2, message_state: 2, context_token: context,
        item_list: [{ type: 1, text_item: { text } }] },
    } })
  }
}
export { loginBase }
