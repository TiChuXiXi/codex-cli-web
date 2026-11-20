import { defaultPresentation } from '../../../shared/router-presentation.js'

// Tencent's client refreshes the transient indicator while composing a reply.
const typingRefreshMs = 5000
const queued = new Set(['queued','creating','submitting','submitted'])

// Notifications use the existing outbox; typing is transient and never holds up delivery.
export class WeChatProgress {
  constructor(channel) { this.channel = channel }

  settings() { return this.channel.router.presentation?.() ?? defaultPresentation }

  active() {
    const { router } = this.channel
    const m = router.active
    return m?.origin && this.channel.owns(m.origin.generation) && !m.handedOff && m.status === 'accepted' &&
      m.routerThreadId === router.session?.id ? m : null
  }

  notify(message, stage, text, readyAt, dispatchId, toolId) {
    if (!this.channel.owns(message?.origin?.generation) || !message?.origin?.inbox) return
    this.channel.delivery.enqueue('progress:' + (dispatchId || message.requestId) + ':' + stage, text, {
      progress: {stage, requestId:message.requestId, dispatchId, toolId}, readyAt, inbox:message.origin.inbox,
      ...(dispatchId && {category:'results'}),
    })
  }

  queued(message) {
    this.notify(message,'inbox','这条消息已收到，正在排队。',Date.now()+1000*this.settings().processingSeconds)
  }

  tool(message, activity) {
    if (!message.origin || !['psm_search','psm_get','list_sessions','get_session'].includes(activity.tool.name)) return
    const { selfName = defaultPresentation.selfName, stageSeconds } = this.settings()
    this.notify(message,'lookup',selfName + '正在查找相关的项目和会话。',message.startedAt+1000*stageSeconds,undefined,activity.id)
  }

  worker(event, immediate = false) {
    if (!['task.queued','task.started'].includes(event?.type)) return
    const {router,store,account} = this.channel
    if (!account?.results && !immediate) return
    const task = store.get('task',event.id)
    if (!task || task.routerThreadId !== router.session?.id) return
    const m = store.get('message','user:'+(task.parentRequestId ?? task.requestId))
    if (!m?.origin || !this.channel.owns(m.origin.generation)) return
    const name = router.projects.get(task.projectId)?.name || '所选项目'
    const running = event.type === 'task.started'
    this.notify(m,running ? 'running' : 'queued','「' + name + '」的任务' + (running ? '已开始执行。' : '已排队。'),
      immediate ? 0 : task.createdAt + 1000*this.settings().stageSeconds,task.id)
    if (immediate) {
      const row = store.wxRead('out','progress:' + task.id + ':' + (running ? 'running' : 'queued'))
      if (row?.state === 'pending') store.wxSave('out',{...row,readyAt:0,category:null})
    }
  }

  valid({stage,requestId,dispatchId,toolId}) {
    const {store,router} = this.channel
    const m = store.get('message','user:'+requestId)
    if (!m?.origin || !this.channel.owns(m.origin.generation) || m.routerThreadId !== router.session?.id) return false
    if (dispatchId) {
      const task = store.get('task',dispatchId)
      if (!task || task.routerThreadId !== m.routerThreadId || (task.parentRequestId ?? task.requestId) !== requestId) return false
      return stage === 'running' ? task.status === 'running' && !!task.turnId : queued.has(task.status)
    }
    if (stage === 'inbox') return m.status === 'queued'
    return this.active()?.requestId === requestId && (!toolId || store.get('message',toolId)?.tool?.status === 'running')
  }

  fallback(m) {
    if (this.active()?.id === m.id) this.notify(m,'processing',(this.settings().selfName ?? defaultPresentation.selfName) + '正在处理这条消息。',0)
  }

  recordTyping(state, phase, outcome) {
    if (this.channel.account !== state.account) return
    const at = Date.now()
    state.diagnostic[phase] = {outcome,at}
    const status = outcome === 'unconfirmed' ? 'unavailable' : phase === 'stop' ? 'stopped' :
      phase === 'ticket' ? 'preparing' : 'started'
    this.lastTyping = {state:status,at,...state.diagnostic}
    const row = this.channel.store.wxRead('in',state.inbox)
    if (row) this.channel.store.wxSave('in',{...row,typing:state.diagnostic})
  }

  tick(signal) {
    const channel = this.channel
    const m = this.active()
    if (!m && !this.current) return
    const prefs = this.settings()
    const requested = m && Date.now() >= m.startedAt + prefs.processingSeconds*1000 ? m : null
    if (this.current && (this.current.id !== requested?.id || this.current.enabled !== prefs.typing)) {
      this.stop()
      return
    }
    if (this.busy || !requested || signal.aborted) return
    const state = this.current ??= {id:requested.id,account:channel.account,enabled:prefs.typing,
      inbox:requested.origin.inbox,diagnostic:{},nextRefresh:0}
    if (Date.now() < state.nextRefresh) return
    state.nextRefresh = Infinity
    if (!state.enabled) { this.fallback(requested); return }
    const current = () => this.current === state && !signal.aborted && this.active()?.id === state.id
    this.busy = true
    state.sending = channel.job(async () => {
      let phase = state.ticket ? 'refresh' : 'ticket'
      try {
        if (!state.ticket) {
          const context = channel.store.wxRead('in',state.inbox)?.context
          if (context) state.ticket = await channel.client.typingTicket(state.account,channel.unseal(context),signal)
          if (!current()) return
          if (!state.ticket) throw Error('typing unavailable')
          this.recordTyping(state,phase,'received')
          phase = 'start'
        }
        state.attempted = true
        await channel.client.typing(state.account,state.ticket,1,signal)
        this.recordTyping(state,phase,'acknowledged')
        state.nextRefresh = Date.now() + typingRefreshMs
      } catch {
        this.recordTyping(state,phase,'unconfirmed')
        if (current()) this.fallback(requested)
      } finally { if (!state.stopping) this.busy = false }
    },()=>{})
  }

  stop() {
    const state = this.current
    this.current = null
    if (state?.attempted) {
      state.stopping = this.busy = true
      this.channel.job(async () => {
        try {
          await state.sending
          await this.channel.client.typing(state.account,state.ticket,2)
          this.recordTyping(state,'stop','acknowledged')
        } catch {
          this.recordTyping(state,'stop','unconfirmed')
        } finally { this.busy = false }
      },()=>{})
    }
  }
}
