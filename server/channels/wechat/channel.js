import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HubError } from '../../codex/hub.js'
import { apiBase, ILinkClient, loginBase } from './ilink.js'
import { WeChatDelivery } from './delivery.js'
import { answerCard, liveCards, matchesShortAnswer, questions, renderCard, shortCode } from './interactions.js'

const bad = message => new HubError('codex-cli/bad-request', message)
const wait = (ms, signal) => sleep(ms, undefined, { signal, ref: false })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const terminal = new Set(['completed', 'failed', 'interrupted'])

export class WeChatChannel {
  constructor(router, client = new ILinkClient()) {
    this.router = router
    this.store = router.store
    this.client = client
    this.jobs = new Set()
    this.delivery = new WeChatDelivery(this)
    this.phase = 'unbound'
    this.cardsDirty = true
    this.unsubscribe = router.bus?.subscribe(event => {
      if (['router/changed','approval/requested','approval/resolved','connection'].includes(event.type)) this.cardsDirty = true
    })
    const saved = this.store.wxRead('binding', 'active')
    if (saved) {
      try {
        this.account = this.unseal(saved.body)
        this.phase = this.account.paused || 'reconnecting'
        this.recover()
        // Before sequential delivery, multiple cards could already be visible in the chat.
        const visible = this.store.wxRows('card','open').filter(card => card.shown)
        if (visible.length > 1) this.store.transaction(() => {
          for (const card of visible) this.defer(card)
          this.pauseQueue('upgrade')
        })
        if (!this.account.paused) this.startPolling()
      } catch {
        this.damaged = true
        this.phase = 'error'
        this.error = '无法恢复微信绑定，请恢复私有状态备份，或解除绑定后重新扫码。'
      }
    }
  }

  key() {
    if (this.localKey) return this.localKey
    const path = join(this.router.directory, 'wechat.key')
    try { this.localKey = readFileSync(path) } catch (error) {
      if (error.code !== 'ENOENT' || this.store.wxRead('binding', 'active')) throw error
      this.localKey = randomBytes(32)
      writeFileSync(path, this.localKey, { mode: 0o600, flag: 'wx', flush: true })
    }
    return this.localKey
  }

  seal(value) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
  }

  unseal(value) {
    const data = Buffer.from(value, 'base64')
    const cipher = createDecipheriv('aes-256-gcm', this.key(), data.subarray(0, 12))
    cipher.setAuthTag(data.subarray(12, 28))
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'))
  }

  saveAccount(account = this.account) {
    this.store.wxSave('binding', { id: 'active', state: 'bound', body: this.seal(account) })
  }

  owns(generation) { return !!this.account && this.account.generation === generation }

  status() {
    const a = this.account
    const count = (kind, state) => this.store.db.prepare('SELECT count(*) AS n FROM wechat_records WHERE kind=? AND state=?').get(kind,state).n
    return { phase: this.phase, hasBinding: !!a || !!this.damaged, owner: a ? '••••' + a.owner.split('@')[0].slice(-4) : null,
      canNotify: !!a?.context && this.phase === 'connected', qr: this.login?.content ?? null,
      loginId: this.login?.id ?? null, results: a?.results ?? true, decisions: a?.decisions ?? true,
      lastReceived: a?.lastReceived ?? null, lastSent: a?.lastSent ?? null, error: this.error ?? null,
      pending: count('out','pending'), unknown: count('out','unknown') + count('in','unknown'), failed: count('out','failed') }
  }

  job(action, onError) {
    const job = action().catch(onError).finally(() => this.jobs.delete(job))
    this.jobs.add(job)
    return job
  }

  recover() {
    this.store.db.exec(`UPDATE wechat_records SET state='unknown',
      data=json_set(data,'$.state','unknown','$.body',null)
      WHERE (kind='out' AND state='sending') OR (kind='in' AND state='responding')`)
  }

  stop() {
    this.controller?.abort()
    this.controller = null
    this.login = null
    this.recover()
    for (const card of this.store.wxRows('card','open')) {
      if (card.values) this.retire(card)
    }
  }

  bind() {
    if (this.closed) throw bad('服务正在关闭')
    if (this.damaged) throw bad('请先解除无法恢复的绑定')
    if (this.account && !this.account.paused && this.phase !== 'error') throw bad('请先断开当前微信')
    this.stop()
    const controller = this.controller = new AbortController()
    const login = this.login = { id: randomUUID(), pin: '', content: '' }
    this.phase = 'waiting_scan'
    this.error = null
    this.job(() => this.scan(login, controller.signal), () => {
      if (controller.signal.aborted) return
      this.login = null
      this.phase = 'error'
      this.error = '微信绑定未完成，请重新扫码。'
    })
    return this.status()
  }

  async scan(login, signal) {
    for (let refresh = 0; refresh < 3; refresh++) {
      const qr = await this.client.qr(signal, this.account?.token)
      if (signal.aborted) return
      if (!qr.qrcode || typeof qr.qrcode_img_content !== 'string' || qr.qrcode_img_content.length > 2500) throw bad('二维码无效')
      login.content = qr.qrcode_img_content
      login.pin = ''
      this.phase = 'waiting_scan'
      let base = loginBase
      const end = Date.now() + 8 * 60000
      while (!signal.aborted && Date.now() < end) {
        let result
        try { result = await this.client.qrStatus(base, qr.qrcode, login.pin, signal) }
        catch (error) {
          if (signal.aborted || error.disposition === 'rejected') throw error
          await wait(1500, signal)
          continue
        }
        if (signal.aborted) return
        const status = result.status
        if (status === 'confirmed') {
          if (![result.bot_token,result.ilink_bot_id,result.ilink_user_id].every(v => typeof v === 'string' && v.trim())) throw bad('无法确认微信身份')
          const account = { generation: randomUUID(), owner: result.ilink_user_id, bot: result.ilink_bot_id,
            token: result.bot_token, base: apiBase(result.baseurl || base), cursor: '', results: true, decisions: true }
          this.store.transaction(() => { this.store.db.exec('DELETE FROM wechat_records'); this.saveAccount(account) })
          this.account = account
          this.login = null
          this.startPolling()
          return
        }
        if (status === 'binded_redirect') throw bad('当前扫码未返回新凭据')
        if (status === 'expired' || status === 'verify_code_blocked') break
        if (status === 'scaned_but_redirect') base = apiBase('https://' + result.redirect_host)
        if (typeof status === 'string' && status.includes('need_verifycode')) {
          this.phase = 'waiting_pin'
          login.pin = ''
          while (!login.pin && Date.now() < end) await wait(200, signal)
        } else if (status === 'scaned') {
          this.phase = 'waiting_confirmation'
          login.pin = ''
        }
        await wait(150, signal)
      }
    }
    throw bad('二维码已过期')
  }

  pin({ loginId, pin } = {}) {
    if (!this.login || this.login.id !== loginId || this.phase !== 'waiting_pin' || !/^\d{1,12}$/.test(String(pin))) throw bad('验证码或绑定请求无效')
    this.login.pin = String(pin)
    this.phase = 'waiting_confirmation'
    return this.status()
  }

  disconnect(remove = false) {
    this.stop()
    if (remove) {
      this.store.db.exec('PRAGMA secure_delete=ON; DELETE FROM wechat_records')
      this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      this.account = null
      this.damaged = false
      this.localKey = null
      rmSync(join(this.router.directory, 'wechat.key'), { force: true })
    } else if (this.account) {
      if (this.account.paused !== 'expired') this.account.paused = 'disconnected'
      this.saveAccount()
    }
    this.phase = this.account?.paused || 'unbound'
    this.error = null
    return this.status()
  }

  resume() {
    if (!this.account || this.account.paused === 'expired') throw bad('请重新扫码绑定')
    this.stop()
    this.account.paused = null
    this.saveAccount()
    this.startPolling()
    return this.status()
  }

  preferences({ results, decisions } = {}) {
    if (!this.account || typeof results !== 'boolean' || typeof decisions !== 'boolean') throw bad('无效的通知设置')
    this.store.transaction(() => {
      Object.assign(this.account, { results, decisions })
      this.saveAccount()
      for (const row of this.store.wxRows('out','pending')) {
        if (row.category && !this.account[row.category]) this.store.wxSave('out', { ...row, state: 'cancelled', body: null })
      }
      if (!decisions) for (const card of this.store.wxRows('card','open')) {
        if (card.category === 'decisions') this.retire(card)
      }
    })
    this.cardsDirty = true
    return this.status()
  }

  expire() {
    this.stop()
    this.account.paused = 'expired'
    this.phase = 'expired'
    this.saveAccount()
  }

  startPolling() {
    const signal = (this.controller = new AbortController()).signal
    const account = this.account
    this.phase = 'reconnecting'
    this.cardsDirty = true
    const failed = () => {
      if (signal.aborted) return
      this.stop()
      this.phase = 'error'
      this.error = '微信本地状态写入失败，请检查状态目录后恢复连接。'
    }
    this.job(() => this.poll(account, signal), failed)
    this.job(() => this.consume(signal), failed)
    this.job(async () => {
      while (!signal.aborted) {
        if (this.cardsDirty || Date.now() >= (this.nextCardCheck ?? 0)) {
          this.cardsDirty = false
          this.nextCardCheck = Date.now() + 10000
          this.syncCards()
        }
        await this.delivery.flush(signal)
        await wait(400, signal)
      }
    }, failed)
  }

  async poll(account, signal) {
    let timeout = 35000, failures = 0
    while (!signal.aborted) {
      let batch
      const pollStarted = Date.now()
      try { batch = await this.client.updates(account, account.cursor, timeout, signal) }
      catch (error) {
        if (signal.aborted) return
        if ([-14,401,403].includes(error.code)) { this.expire(); return }
        if (error.code === 'timeout') continue
        this.phase = 'reconnecting'
        await wait(++failures < 3 ? 2000 : 30000, signal)
        continue
      }
      if (signal.aborted || this.account !== account) return
      this.accept(batch)
      this.phase = 'connected'
      this.error = null
      failures = 0
      if (Number.isFinite(batch.longpolling_timeout_ms)) timeout = Math.max(1000, Math.min(120000, batch.longpolling_timeout_ms))
      if (!batch.msgs?.length && Date.now() - pollStarted < 200) await wait(200, signal)
    }
  }

  accept(batch) {
    const account = this.account
    if (!account || (batch.msgs !== undefined && !Array.isArray(batch.msgs))) throw bad('微信消息格式错误')
    const changes = {}
    this.store.transaction(() => {
      for (const msg of batch.msgs ?? []) {
        if (!msg || msg.message_type !== 1 || msg.from_user_id !== account.owner || msg.group_id ||
            (msg.to_user_id && msg.to_user_id !== account.bot)) continue
        const items = msg.item_list
        if (!Array.isArray(items) || !items.length || !items.every(i => i?.type === 1 && typeof i.text_item?.text === 'string')) continue
        const text = items.map(i => i.text_item.text).join('\n').trim()
        if (!text) continue
        const external = msg.message_id || items.find(i => i.msg_id)?.msg_id || msg.client_id
        const id = hash([account.generation, account.owner, external || msg])
        if (this.store.wxRead('in', id)) continue
        const context = msg.context_token && this.seal(msg.context_token)
        const open = this.store.wxRows('card','open')
        const head = open.find(card => !card.deferred)
        const shown = head?.shown ? [{ id: head.id, index: head.index ?? 0, presentation: head.presentation ?? 0 }] : []
        this.store.wxSave('in', { id, state: external && text.length <= 12000 ? 'pending' : 'unknown',
          body: external && text.length <= 12000 ? this.seal(text) : null, context, shown,
          privatePending:open.some(card => card.privateInput), relatedTasks: account.relatedTasks })
        changes.lastReceived = Date.now()
        if (context) changes.context = context
      }
      if (typeof batch.get_updates_buf === 'string' && batch.get_updates_buf) changes.cursor = batch.get_updates_buf
      if (Object.keys(changes).length) this.saveAccount({ ...account, ...changes })
    })
    Object.assign(account, changes)
  }

  async consume(signal) {
    while (!signal.aborted) {
      if (this.router.session && !this.router.upgrade?.running) {
        for (const row of this.store.wxRows('in','pending')) {
          if (signal.aborted) return
          await this.handle(row, signal)
        }
      }
      await wait(150, signal)
    }
  }

  retire(card) {
    if (!card.answeredHere && !card.deferred &&
        (card.shown || this.store.wxRows('out','sending').some(out => out.card === card.id))) this.pauseQueue(card.id)
    this.store.wxSave('card', { ...card, state: 'closed', values: null, closedAt: Date.now() })
  }

  queueHead() {
    return this.store.wxRows('card','open').find(card => !card.deferred)
  }

  pauseQueue(after) {
    this.store.wxSave('queue', { id:'active', state:'paused', after })
  }

  defer(card) {
    this.store.wxSave('card', { ...card, deferred:true, shown:false, presentation:(card.presentation ?? 0) + 1 })
  }

  showAgain(card, entry, inbox) {
    const presentation = (card.presentation ?? 0) + 1
    this.store.wxSave('card', { ...card, deferred:false, shown:false, presentation })
    this.delivery.enqueue('show:' + card.id + ':' + presentation, renderCard(entry, card.index ?? 0), {
      card:card.id, presentation, inbox, category:card.category,
    })
  }

  syncCards() {
    if (!this.account || !this.router.session) return
    const live = liveCards(this.router)
    const existing = this.store.wxRows('card','open')
    for (const card of existing) if (!live.has(card.key) && card.id !== this.answering) this.retire(card)
    for (const entry of live.values()) {
      if (existing.some(c => c.key === entry.key)) continue
      if (entry.type === 'choice') {
        // A confirmed candidate can lead to another permission or project choice after its Router turn ended.
        const source = this.store.get('message', 'user:' + entry.item.requestId)
        if (source?.origin && this.owns(source.origin.generation) && terminal.has(source.status)) {
          this.offer(entry, { inbox: source.origin.inbox })
        }
      } else if (this.account.decisions) this.offer(entry, { category: 'decisions' })
    }
  }

  offer(entry, options) {
    const code = shortCode(this.store)
    const card = { id: code, state: 'open', key: entry.key, category: options.category,
      privateInput: entry.type === 'input' && entry.request.params.questions?.some(q => q.isSecret) }
    this.store.wxSave('card', card)
    this.delivery.enqueue('card:' + code, [options.intro, renderCard(entry)].filter(Boolean).join('\n\n'),
      { category: options.category, inbox: options.inbox, card: code })
  }

  reply(message, answer) {
    if (!this.owns(message.origin.generation)) return
    if (message.status === 'unknown') {
      this.delivery.enqueue('uncertain:' + message.origin.inbox, '这条消息的执行结果待核对。工作台会保留记录，请先查询进展。', { inbox: message.origin.inbox })
      return
    }
    if (!terminal.has(message.status)) return
    const inbox = message.origin.inbox
    const dispatch = this.store.get('dispatch-key', message.requestId)
    const cards = [...liveCards(this.router).values()].filter(entry => entry.type === 'choice'
      ? entry.item.requestId === message.requestId
      : this.account.decisions && dispatch && (entry.request ?? entry.message).dispatchId === dispatch.id)
    if (cards.length) {
      for (const entry of cards) {
        const current = this.store.wxRows('card','open').find(c => c.key === entry.key)
        const intro = answer?.slice(0, 400)
        if (!current) this.offer(entry, { inbox, intro })
        else {
          const out = this.store.wxRead('out', 'card:' + current.id)
          if (out?.state === 'pending') {
            this.store.wxSave('card', { ...current, category: null })
            this.store.wxSave('out', { ...out, inbox, category: null,
              body: this.seal([intro, renderCard(entry)].filter(Boolean).join('\n\n')) })
          }
        }
      }
      const head = this.queueHead()
      if (!cards.some(entry => entry.key === head?.key) || this.store.wxRead('queue','active')?.state === 'paused') {
        this.delivery.enqueue('queued:' + inbox, '这项请求已加入微信待办队列。发“待办”可查看当前题目。', { inbox })
      }
    } else {
      const content = answer || (message.status === 'completed' ? null : 'Router 回合未完成。')
      if (content) this.delivery.enqueue('reply:' + inbox, content.length > 3500 ? content.slice(0,3450) + '\n（完整答复已保存在 Web Router）' : content, { inbox })
    }
  }

  terminal(task, receipt) { this.delivery.terminal(task, receipt) }
  receipt(batch, status, text) { this.delivery.receipt(batch, status, text) }

  async handle(row, signal) {
    const generation = this.account.generation
    const text = this.unseal(row.body)
    const explicit = /^#([0-9a-f]{8})(?:\s+|$)([\s\S]*)$/i.exec(text)
    const addressedAnswer = /^回答[：:]\s*([\s\S]+)/.exec(text)
    const task = /^任务[：:]\s*([\s\S]+)/.exec(text)
    this.syncCards()
    const live = liveCards(this.router)
    const head = this.queueHead()
    const open = this.store.wxRows('card','open')
    const queue = this.store.wxRead('queue','active')
    const paused = queue?.state === 'paused'
    const ref = row.shown.length === 1 && row.shown[0]
    const presented = ref && head?.shown && ref.id === head.id && ref.index === (head.index ?? 0) &&
      (ref.presentation ?? 0) === (head.presentation ?? 0)
    const entry = head && live.get(head.key)
    const finish = (reply, state = 'done', update) => {
      this.store.transaction(() => {
        update?.()
        this.store.wxSave('in', { ...row, state, body: null })
        if (reply) this.delivery.enqueue('ack:' + row.id, reply, { inbox: row.id })
      })
    }
    let card
    if (!task) {
      if (text === '待办' || (text === '继续' && (paused || !head && open.length))) {
        return finish(open.length ? null : '当前没有待办。', 'done', () => {
          this.store.wxSave('queue', { id:'active', state:'ready' })
          // A new presentation invalidates replies captured against an older prompt.
          for (const next of head ? [head] : open) {
            if (live.has(next.key)) this.showAgain(next, live.get(next.key), row.id)
          }
        })
      }
      const skip = /^(?:下一个|下一项|跳过|暂不处理|稍后处理)$/.test(text)
      if (paused && (open.length || row.shown.length || skip || addressedAnswer || explicit ||
          /^(?:允许|同意|拒绝|是|否|\d+)$/.test(text) ||
          this.store.wxRead('card',queue.after)?.privateInput)) {
        return finish('上一项待办已处理或失效。发“继续”查看下一项，另发任务用“任务：…”。')
      }
      if ((row.shown.length && (!presented || !entry)) || (explicit && explicit[1].toUpperCase() !== head?.id)) {
        return finish('刚才的待办已处理或切换。发“待办”查看当前问题。')
      }
      if (skip) {
        if (!presented) return finish(open.length ? '发“待办”查看当前问题。' : '当前没有待办。')
        return finish('已暂缓，原请求保留。发“待办”可回看。', 'done', () => this.defer(head))
      }
      if (presented && entry) {
        const isQuestion = entry.type === 'input' || entry.type === 'question'
        const q = isQuestion && questions(entry)[head.index ?? 0]
        if (explicit || matchesShortAnswer(entry, text, head.index ?? 0) ||
            isQuestion && (addressedAnswer || !q?.options?.length || q.isSecret)) card = head
        else if (isQuestion || /^(?:允许|同意|拒绝|取消|是|否|好|确认|\d+)$/.test(text)) {
          return finish('请按当前题目给出的选项回答。发“待办”可重看题目，发“下一个”可暂缓。')
        }
      } else if (row.privatePending || open.some(c => c.privateInput) || explicit || addressedAnswer ||
          /^(?:允许|批准|同意|拒绝|不同意|取消|\d+)$/.test(text)) {
        return finish(open.length ? '发“待办”查看当前问题后再回答。' : '没有可对应的有效待办。')
      }
    }
    if (!card) {
      if (this.router.phase !== 'ready') return
      this.store.transaction(() => {
        this.router.admit({ requestId: 'wx-' + row.id, text: task?.[1] || text }, { generation, inbox: row.id, relatedTasks: row.relatedTasks })
        this.store.wxSave('in', { ...row, state: 'done', body: null })
      })
      this.router.kickInputs()
      return
    }
    if (live.get(card.key).type === 'choice' && this.router.phase !== 'ready') return
    const value = explicit ? explicit[2].trim() : addressedAnswer?.[1] ?? text
    if (!value) return finish('请发送当前题目的答案。')
    this.store.wxSave('in', { ...row, state: 'responding', body: null })
    let response
    try {
      this.answering = card.id
      response = await answerCard(this.router, live.get(card.key), value, card.values ? this.unseal(card.values) : [])
    } catch (error) {
      if (signal.aborted || !this.owns(generation)) return
      return finish(error.code === 'codex-cli/router-stale' ? '这项请求已处理或失效。' : '响应结果待核对，请查看工作台。', 'unknown')
    } finally { this.answering = null }
    if (signal.aborted || !this.owns(generation)) return
    this.store.transaction(() => {
      if (response.done) {
        this.retire({ ...card, answeredHere: true })
        const entry = live.get(card.key)
        this.router.store.put('message', 'wx-action:' + row.id, { id: 'wx-action:' + row.id, role: 'user',
          dispatchId: entry.request?.dispatchId ?? entry.message?.dispatchId, interactionMethod: entry.request?.method,
          label: '你 · 微信', text: entry.label + ' · ' + response.summary, status: 'completed' })
      } else if (response.answers) {
        this.store.wxSave('card', { ...card, shown: false, values: this.seal(response.answers), index: response.answers.length })
      }
      this.store.wxSave('in', { ...row, state: 'done', body: null })
      let acknowledgement = response.hint || '已将你的回答传回工作台。'
      if (response.done && !this.queueHead() && this.store.wxRows('card','open').some(c => c.deferred)) {
        acknowledgement += '\n还有暂缓的待办，发“待办”可继续处理。'
      }
      this.delivery.enqueue('ack:' + row.id, acknowledgement, { inbox: row.id,
        ...(!response.done && { card: card.id, presentation:card.presentation ?? 0 }) })
    })
    this.router.publish()
  }

  async close() {
    this.closed = true
    this.unsubscribe?.()
    this.controller?.abort()
    this.recover()
    await Promise.allSettled([...this.jobs])
  }
}
