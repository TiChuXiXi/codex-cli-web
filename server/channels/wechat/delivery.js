import { randomUUID } from 'node:crypto'
import { liveCards } from './interactions.js'

const labels = { completed: '回合已结束', failed: '执行失败', interrupted: '执行中断' }

export class WeChatDelivery {
  constructor(channel) {
    this.channel = channel
    this.store = channel.store
  }

  enqueue(id, text, options = {}) {
    const account = this.channel.account
    if (!account || this.store.wxRead('out', id)) return
    this.store.wxSave('out', { id, state: 'pending', generation: account.generation, clientId: randomUUID(),
      createdAt: Date.now(), ...options, body: this.channel.seal(text) })
  }

  terminal(task, receipt) {
    const { channel } = this
    if (!channel.account?.results || task.routerThreadId !== channel.router.session?.id) return
    const label = channel.router.dispatcher.workerLabel(task)
    this.enqueue('worker:' + task.id, label + '：' + labels[task.status] + '。详细记录已保存在工作台。', {
      category: 'results', tasks: [task.id], readyAt: Date.now() + (receipt ? 60000 : 0),
    })
  }

  receipt(batch, status, text) {
    if (!['delivered', 'unknown', 'failed'].includes(status) || !this.channel.account?.results) return
    const rows = batch.dispatchIds.map(id => this.store.wxRead('out', 'worker:' + id))
    const eligible = rows.filter(row => row?.state === 'pending')
    if (!eligible.length) return
    // Only a complete, still-eligible batch can use its Router-written summary.
    if (eligible.length === rows.length && text && !text.startsWith('Worker 执行回执\n')) {
      const summary = text.replace(/```[\s\S]*?(?:```|$)/g, '（详见工作台）').slice(0, 900)
      this.enqueue('batch:' + batch.id, '【任务结果】\n' + summary, { category: 'results', tasks: batch.dispatchIds })
      for (const row of eligible) this.store.wxSave('out', { ...row, state: 'merged', body: null })
    } else {
      for (const row of eligible) this.store.wxSave('out', { ...row, readyAt: 0 })
    }
  }

  async flush(signal) {
    const channel = this.channel
    const account = channel.account
    if (!account || account.paused || !account.context) return
    const pending = this.store.wxRows('out', 'pending')
    // Confirm the preceding answer before displaying the next question.
    pending.sort((a,b) => Number(Boolean(a.card)) - Number(Boolean(b.card)))
    for (const row of pending) {
      if (signal.aborted || account !== channel.account) return
      if (row.readyAt > Date.now()) continue
      if (row.after) {
        const queue = this.store.wxRead('queue','active')
        if (queue?.state !== 'paused' || queue.after !== row.after) {
          this.store.wxSave('out', { ...row, state:'cancelled', body:null })
          continue
        }
      }
      const card = row.card && this.store.wxRead('card', row.card)
      if (card && !channel.router.session) continue
      if (card && (card.presentation ?? 0) !== (row.presentation ?? 0)) {
        this.store.wxSave('out', { ...row, state:'cancelled', body:null })
        continue
      }
      if (row.generation !== account.generation || (row.category && !account[row.category]) ||
          (row.card && (!card || card.state !== 'open' || !liveCards(channel.router).has(card.key)))) {
        this.store.wxSave('out', { ...row, state: 'cancelled', body: null })
        if (row.inbox && row.generation === account.generation && row.card && !row.category) {
          this.enqueue('closed:' + row.inbox, '这项待办已处理或失效。', { inbox: row.inbox })
        }
        continue
      }
      if (card) {
        if (card.deferred || channel.queueHead()?.id !== card.id) continue
        const queue = this.store.wxRead('queue','active')
        if (queue?.state === 'paused') {
          this.enqueue('handoff:' + queue.after, '上一项待办已处理或失效。发“继续”查看下一项。', {
            category:row.category, inbox:row.inbox, after:queue.after,
          })
          continue
        }
      }
      if (card?.key.startsWith('worker-question:')) {
        try { await channel.router.dispatcher.currentQuestion(card.key) }
        catch (error) {
          if (signal.aborted || account !== channel.account) return
          if (error.code === 'codex-cli/router-stale') channel.retire(card)
          else this.store.wxSave('out', { ...row, readyAt: Date.now() + 5000 })
          continue
        }
        if (signal.aborted || account !== channel.account) return
        if (this.store.wxRead('out',row.id)?.state !== 'pending' || !liveCards(channel.router).has(card.key)) continue
        if (channel.queueHead()?.id !== card.id || (this.store.wxRead('card',card.id)?.presentation ?? 0) !== (row.presentation ?? 0) ||
            this.store.wxRead('queue','active')?.state === 'paused') continue
      }
      const context = row.inbox ? this.store.wxRead('in', row.inbox)?.context : account.context
      if (!context) continue
      this.store.wxSave('out', { ...row, state: 'sending' })
      try {
        const response = await channel.client.send(account, { clientId: row.clientId,
          text: channel.unseal(row.body), context: channel.unseal(context) }, signal)
        if (account !== channel.account || signal.aborted) return
        this.store.transaction(() => {
          this.store.wxSave('out', { ...row, state: 'sent', body: null, serverId: response.message_id, sentAt: Date.now() })
          if (card) {
            const current = this.store.wxRead('card', card.id)
            if (current?.state === 'open' && !current.deferred && (current.presentation ?? 0) === (row.presentation ?? 0)) {
              this.store.wxSave('card', { ...current, shown: true, shownAt: Date.now() })
            }
          }
          if (row.tasks) account.relatedTasks = row.tasks
          account.lastSent = Date.now()
          channel.saveAccount()
        })
      } catch (error) {
        if (account !== channel.account || signal.aborted) return
        const stale = error.code === -14 || error.code === 401 || error.code === 403
        const retry = stale || error.disposition === 'retry'
        this.store.wxSave('out', { ...row, state: retry ? 'pending' :
          error.disposition === 'rejected' ? 'failed' : 'unknown', attempts: (row.attempts ?? 0) + 1,
          readyAt: Date.now() + Math.min(60000, 2000 * 2 ** Math.min(5, row.attempts ?? 0)) })
        if (stale) channel.expire()
        if (retry) break
      }
    }
  }
}
