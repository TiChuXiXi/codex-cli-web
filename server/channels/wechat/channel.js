import { approvalDetails } from '../../../shared/approval-details.js'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HubError } from '../../codex/hub.js'
import { apiBase, ILinkClient, loginBase } from './ilink.js'
import { WeChatDelivery } from './delivery.js'
import { WeChatProgress } from './progress.js'
import { ambiguousChoice, approvalFingerprint, answerCard, liveCards, matchesShortAnswer, questions, renderCard, shortCode } from './interactions.js'

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
    this.progress = new WeChatProgress(this)
    this.phase = 'unbound'
    this.cardsDirty = true
    this.unsubscribe = router.bus?.subscribe(event => {
      if (event.type === 'router/changed') this.progress.worker(event.payload)
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
      lastTyping:this.progress.lastTyping ?? null,
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
    this.progress.stop()
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
        this.progress.tick(signal)
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
        const head = this.queueHead()
        const queue = this.store.wxRead('queue','active')
        const shown = head?.shown ? [{ id: head.id, index: head.index ?? 0, presentation: head.presentation ?? 0 }] : []
        this.store.wxSave('in', { id, state: external && text.length <= 12000 ? 'pending' : 'unknown',
          body: external && text.length <= 12000 ? this.seal(text) : null, context, shown,
          ...(Number.isSafeInteger(msg.create_time_ms) && msg.create_time_ms > 0 && { sentByUserAt: msg.create_time_ms }),
          ...(open.length && queue?.menu && { menu: queue.after }),
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
    const menu = this.store.wxRead('queue','active')?.menu
    this.store.wxSave('card', { ...card, state: 'closed', values: null, stepHint: null, closedAt: Date.now() })
    if (menu) {
      if (!this.store.wxRows('card','open').some(c => menu.includes(c.id))) this.pauseQueue(card.id)
    } else if (!card.answeredHere && !card.deferred &&
        (card.shown || this.store.wxRows('out','sending').some(out => out.card === card.id))) this.pauseQueue(card.id)
  }

  queueHead() {
    const open = this.store.wxRows('card','open')
    const focus = this.store.wxRead('queue','active')?.focus
    return open.find(card => card.id === focus && !card.deferred) ?? open.find(card => !card.deferred)
  }

  pauseQueue(after) {
    this.store.wxSave('queue', { id:'active', state:'paused', after })
  }

  defer(card) {
    this.store.wxSave('card', { ...card, deferred:true, shown:false, presentation:(card.presentation ?? 0) + 1 })
  }

  menuName(entry) {
    if (entry.item?.candidates?.length === 1) return entry.item.candidates[0].name
    return (entry.label ?? '').replace(/^Worker · /,'').split(' · ')[0]
  }

  sendMenu(open, live, inbox) {
    const cards = open.filter(c => live.has(c.key))
    if (!cards.length) return
    const names = cards.map(c => this.menuName(live.get(c.key)))
    const lines = cards.map((c,i) => {
      const entry = live.get(c.key)
      const subject = entry.item?.kind === 'psmAccess' ? '允许阅读 ' + names[i] + ' 的会话历史？' : entry.label
      const needCode = !names[i] || names.indexOf(names[i]) !== names.lastIndexOf(names[i])
      return (needCode ? '#' + c.id + ' ' : '') + String(subject).slice(0,60)
    })
    const after = 'menu:' + inbox
    this.store.wxSave('queue',{id:'active',state:'paused',after,menu:cards.map(c=>c.id)})
    this.delivery.enqueue(after,'要看哪一项？请回复项目名，同名可发对应的 #编号。\n' + lines.join('\n'),{inbox,after})
  }

  focusCard(card, live, inbox) {
    const previous = this.queueHead()
    if (previous && previous.id !== card.id && live.has(previous.key) &&
        (previous.shown || this.store.wxRows('out','sending').some(row => row.card === previous.id))) {
      // Switching also invalidates a previous card whose transmission may still be in flight.
      this.showAgain(previous,live.get(previous.key),previous.inbox)
    }
    this.store.wxSave('queue',{id:'active',state:'ready',focus:card.id})
    this.showAgain(card,live.get(card.key),inbox)
  }

  cardText(card, entry) {
    const value = card.values && this.unseal(card.values)
    const savedHint = value && card.stepHint && this.unseal(card.stepHint)
    return (savedHint || renderCard(entry, card.index ?? 0)) + '\n待办 #' + card.id
  }

  showAgain(card, entry, inbox) {
    const presentation = (card.presentation ?? 0) + 1
    this.store.wxSave('card', { ...card, deferred:false, shown:false, presentation })
    this.delivery.enqueue('show:' + card.id + ':' + presentation, this.cardText(card, entry), {
      card:card.id, presentation, inbox, category:card.category,
    })
  }

  syncCards() {
    if (!this.account || !this.router.session) return
    const live = liveCards(this.router)
    this.store.transaction(() => this.reconcileCards(live))
  }

  reconcileCards(live) {
    const existing = this.store.wxRows('card','open')
    for (const card of existing) if (!live.has(card.key) && card.id !== this.answering) this.retire(card)
    for (const entry of live.values()) {
      const current = existing.find(c => c.key === entry.key)
      if (current) {
        if (entry.type === 'approval' && current.fingerprint !== approvalFingerprint(entry.request)) {
          const next = { ...current, fingerprint: approvalFingerprint(entry.request) }
          if (!current.deferred) this.showAgain(next, entry, current.inbox)
          else this.store.wxSave('card', next)
        }
        continue
      }
      if (entry.item) {
        // A confirmed candidate can lead to another permission or project choice after its Router turn ended.
        const source = this.store.get('message', 'user:' + (entry.item.parentRequestId ?? entry.item.requestId))
        if (source?.origin && this.owns(source.origin.generation)) {
          this.offer(entry, { inbox: source.origin.inbox })
        } else if (!source?.origin && this.account.decisions) this.offer(entry, { category: 'decisions' })
      } else if (this.account.decisions) this.offer(entry, { category: 'decisions' })
    }
  }

  offer(entry, options) {
    const code = shortCode(this.store)
    const card = { id: code, state: 'open', key: entry.key, category: options.category, inbox: options.inbox,
      ...(entry.type === 'approval' && { fingerprint: approvalFingerprint(entry.request) }),
      privateInput: entry.type === 'input' && entry.request.params.questions?.some(q => q.isSecret) }
    this.store.wxSave('card', card)
    this.delivery.enqueue('card:' + code, [options.intro, this.cardText(card, entry)].filter(Boolean).join('\n\n'),
      { category: options.category, inbox: options.inbox, card: code,
        ...(entry.type === 'approval' && !approvalDetails(entry.request).complete && {readyAt: Date.now() + 2000}) })
  }

  reply(message, answer) {
    if (!this.owns(message.origin.generation)) return
    if (message.status === 'unknown') {
      this.delivery.enqueue('uncertain:' + message.origin.inbox, '这条消息的执行结果待核对。工作台会保留记录，请先查询进展。', { inbox: message.origin.inbox })
      return
    }
    if (!terminal.has(message.status)) return
    const inbox = message.origin.inbox
    if (message.origin.choice) {
      const ref = message.origin.choice
      const item = this.store.get('clarification', ref.id)
      const current = item?.status === 'pending' && item.revision === ref.revision && item.expiresAt > Date.now()
      const index = current && item.candidates.findIndex(c => c.id === message.suggestedCandidate)
      const hint = !current ? '这项选择已处理或失效。' : Number.isInteger(index) && index >= 0 ?
        '你说的可能是第 ' + (index + 1) + ' 项。请发“待办”核对候选后回复编号。' : '还不能确定是哪项。请发“待办”查看候选并回复编号。'
      this.delivery.enqueue('reply:' + inbox, hint, { inbox })
      return
    }
    const dispatch = this.store.get('dispatch-key', message.requestId)
    const cards = [...liveCards(this.router).values()].filter(entry => entry.item
      ? (entry.item.parentRequestId ?? entry.item.requestId) === message.requestId
      : this.account.decisions && ((dispatch && dispatch.id === (entry.request ?? entry.message).dispatchId) ||
        this.store.get('task', (entry.request ?? entry.message).dispatchId)?.parentRequestId === message.requestId))
    if (cards.length) {
      for (const entry of cards) {
        const current = this.store.wxRows('card','open').find(c => c.key === entry.key)
        const intro = entry.item || dispatch && this.store.get('task',dispatch.id) ? undefined : answer?.slice(0, 400)
        if (!current) this.offer(entry, { inbox, intro })
        else {
          const out = this.store.wxRead('out', 'card:' + current.id)
          if (out?.state === 'pending' && !out.part) {
            this.store.wxSave('card', { ...current, category: null })
            this.store.wxSave('out', { ...out, inbox, category: null,
              body: this.seal([intro, this.cardText(current, entry)].filter(Boolean).join('\n\n')) })
          }
        }
      }
      const head = this.queueHead()
      if (!cards.some(entry => entry.key === head?.key) || this.store.wxRead('queue','active')?.state === 'paused') {
        this.sendMenu(this.store.wxRows('card','open'), liveCards(this.router), inbox)
      }
    } else {
      const linked = this.store.list('task').filter(t => t.routerThreadId === this.router.session?.id &&
        (t.parentRequestId ?? t.requestId) === message.requestId)
      if (linked.length && message.status === 'completed' && this.account.results) {
        for (const task of linked) {
          if (task.status === 'running' && task.turnId) this.progress.worker({id:task.id,type:'task.started'},true)
          else if (['queued','creating','submitting','submitted'].includes(task.status)) this.progress.worker({id:task.id,type:'task.queued'},true)
        }
        // Waiting tasks have their own decision cards; completed tasks have their own receipts.
        return
      }
      const content = answer || (message.status === 'completed' ? null : '这轮处理没有完成。')
      if (content) this.delivery.enqueue('reply:' + (message.origin.continuedFrom ? message.requestId : inbox), content.length > 3500 ? content.slice(0,3450) + '\n（完整答复已保存在 Web Router）' : content, { inbox })
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
    const presented = ref && head?.shown && !(row.sentByUserAt < head.shownAt) &&
      ref.id === head.id && ref.index === (head.index ?? 0) &&
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
    let choice
    if (!task) {
      const view = /^查看\s*(.+)$/u.exec(text)
      if (row.menu && row.menu !== queue?.after && !view && !explicit && text !== '待办') {
        return finish('刚才的待办列表已切换。发“待办”查看当前项目。')
      }
      if (view && !open.length) return finish('当前没有待办。')
      if ((view || row.menu && text !== '待办' && !explicit) && open.length) {
        const name = (view?.[1] ?? text).trim()
        const matches = open.filter(row => {
          const entry = live.get(row.key)
          if (!entry || !view && !queue.menu.includes(row.id)) return false
          return this.menuName(entry) === name || entry.label?.replace(/^Worker · /,'') === name
        })
        if (matches.length === 1) return finish(null,'done',() => this.focusCard(matches[0],live,row.id))
        return finish(null,'done',() => this.sendMenu(open,live,row.id))
      }
      if (explicit && !explicit[2].trim()) {
        const selected = open.find(c => c.id === explicit[1].toUpperCase())
        if (!selected || !live.has(selected.key)) return finish('这项待办已处理或失效。')
        return finish(null, 'done', () => this.focusCard(selected,live,row.id))
      }
      if (text === '待办' && open.length > 1) return finish(null,'done',() => this.sendMenu(open,live,row.id))
      if (row.menu && !open.length && text !== '待办') return finish('刚才列表里的待办已处理或失效。')
      if (queue?.menu && open.length && !row.menu && !['待办','继续'].includes(text)) {
        return finish(null,'done',() => this.sendMenu(open,live,row.id))
      }
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
        if (entry.type === 'approval' && !explicit && !/^[123]$/.test(text) && queue?.focus !== head.id &&
            open.filter(c => live.get(c.key)?.type === 'approval').length > 1 && matchesShortAnswer(entry, text)) {
          return finish(null,'done',() => this.sendMenu(open,live,row.id))
        }
        if (ambiguousChoice(entry, text)) return finish('有多个候选符合。请回复编号。')
        if (explicit || matchesShortAnswer(entry, text, head.index ?? 0) ||
            isQuestion && (addressedAnswer || !q?.options?.length || q.isSecret)) card = head
        else if (entry.type === 'choice' && entry.item.semanticChoice && !head.values &&
            (addressedAnswer || /(?:那个|那项|那个会话|之前的|的那个|的那项)[。！]?$|^(?:我指的|我说的|选择|选一下)/.test(text))) {
          choice = { id: entry.item.id, revision: entry.item.revision }
        } else if (isQuestion || /^(?:确定|可以|继续|允许|同意|拒绝|取消|是|否|好|确认|\d+)$/.test(text)) {
          return finish('请按当前题目给出的选项回答。发“待办”可重看题目，发“下一个”可暂缓。')
        }
      } else if (row.privatePending || open.some(c => c.privateInput) || explicit || addressedAnswer ||
          /^(?:允许|批准|同意|拒绝|不同意|确定|确认授权|确认设置|都不是|第[一二三四1-4][个项]?|取消|\d+)$/.test(text)) {
        return finish(open.length ? '发“待办”查看当前问题后再回答。' : '没有可对应的有效待办。')
      }
    }
    if (!card) {
      if (this.router.phase !== 'ready') return
      this.store.transaction(() => {
        // An explicitly new input after an empty queue starts a fresh conversation.
        // Replies captured against the retired card were rejected above.
        if (paused && !open.length && !row.shown.length) this.store.wxSave('queue', { id:'active', state:'ready' })
        this.router.admit({ requestId: 'wx-' + row.id, text: task?.[1] || text }, { generation, inbox: row.id, relatedTasks: row.relatedTasks, ...(choice && { choice }) })
        this.store.wxSave('in', { ...row, state: 'done', body: null })
      })
      this.router.kickInputs()
      return
    }
    if (live.get(card.key).item && this.router.phase !== 'ready') return
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
          routerThreadId: this.router.session.id, dispatchId: response.dispatchId ?? entry.request?.dispatchId ?? entry.message?.dispatchId,
          interactionMethod: response.interactionMethod ?? entry.request?.method,
          ...(entry.request && {instanceId:entry.request.instanceId}),
          ...(response.questionId && { questionId: response.questionId }),
          ...(response.receiptEvidence && { receiptEvidence: response.receiptEvidence }),
          label: '你 · 微信', text: entry.label + ' · ' + response.summary, status: 'completed' })
      } else if (response.answers) {
        this.store.wxSave('card', { ...card, shown: false, values: this.seal(response.answers), index: response.answers.length,
          ...(live.get(card.key).item && { stepHint: this.seal(response.hint) }) })
      }
      this.store.wxSave('in', { ...row, state: 'done', body: null })
      let acknowledgement = response.hint || response.summary || '已提交回答。'
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
    this.progress.stop()
    this.unsubscribe?.()
    this.controller?.abort()
    this.recover()
    await Promise.allSettled([...this.jobs])
  }
}
