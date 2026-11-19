// Web and iLink share one RouterService and its persisted primary pointer.
export class RouterSessionUpgrade {
  constructor(router) {
    this.router = router
    this.timer = setInterval(() => this.check(), 5000)
    this.timer.unref()
  }
  pending(holdingNewInputs = false) {
    const r = this.router,
      s = r.store
    if (
      r.active ||
      r.nativeBusy ||
      r.confirming.size ||
      r.creatingProjects.size ||
      r.wake?.running ||
      r.hub.status().phase !== 'ready' ||
      r.hub.pendingApprovals().length ||
      r.followups?.hasPending?.()
    )
      return true
    const exists = (kind, condition) =>
      Boolean(s.db.prepare('SELECT 1 FROM router_records WHERE kind=? AND ' + condition + ' LIMIT 1').get(kind))
    if (
      exists('task', "json_extract(value,'$.status') NOT IN ('created','completed','failed','interrupted')") ||
      exists('message', "json_extract(value,'$.status') IN ('queued','sending','accepted','unknown','pending')") ||
      s.db.prepare("SELECT 1 FROM router_receipts WHERE state IN ('pending','claimed','unknown') LIMIT 1").get() ||
      s.wakeRecovery(r.session.id).length ||
      s
        .list('clarification')
        .some((c) => c.status === 'confirming' || (c.status === 'pending' && c.expiresAt > Date.now()))
    )
      return true
    return Boolean(
      s.db
        .prepare(
          `SELECT 1 FROM wechat_records WHERE
      (kind='in' AND (state IN ('responding','unknown') OR (state='pending' AND ?=0))) OR
      (kind='out' AND state IN ('pending','sending','unknown')) OR (kind='card' AND state='open') LIMIT 1`,
        )
        .get(holdingNewInputs ? 1 : 0),
    )
  }
  check() {
    const r = this.router
    if (
      this.running ||
      r.closed ||
      r.phase !== 'ready' ||
      !r.psm?.preference.enabled ||
      r.app?.policyVersion !== 2 ||
      !r.session ||
      r.session.policyVersion === 2
    )
      return
    if (this.pending()) return
    this.running = this.run(r.app, r.session)
      .catch(() => {
        this.error = '会话升级等待核对'
      })
      .finally(() => {
        this.running = null
        if (!r.closed) {
          r.kickInputs()
          r.wake.kick()
        }
      })
  }
  async run(app, previous) {
    const r = this.router,
      store = r.store
    const current = () => !r.closed && r.app === app && r.session?.id === previous.id && r.psm.preference.enabled
    if ((await r.readThreadStatus(app, previous.id)) !== 'idle' || !current() || this.pending(true)) return
    if ((await r.hub.psmWorkerBusy?.()) || !current() || this.pending(true)) return
    let intent = store.get('psm-upgrade', previous.id)
    if (intent?.phase === 'starting') {
      this.error = '创建结果待核对'
      return
    }
    const recovering = Boolean(intent?.newId)
    if (!intent?.newId) {
      store.put('psm-upgrade', previous.id, { phase: 'starting', at: Date.now() })
      const { thread } = await app.start()
      if (!thread?.id || thread.id === previous.id || thread.cwd !== app.cwd) throw Error('Invalid replacement')
      intent = store.put('psm-upgrade', previous.id, { phase: 'prepared', newId: thread.id })
    }
    if (!current() || this.pending(true)) return
    if ((await r.readThreadStatus(app, previous.id)) !== 'idle' || !current() || this.pending(true)) return
    if ((await r.hub.psmWorkerBusy?.()) || !current() || this.pending(true)) return
    let target
    try {
      target = await app.request('thread/read', { threadId: intent.newId, includeTurns: false })
    } catch (error) {
      // An acknowledged but unused thread may have had no rollout when its server exited.
      // Never resubmit an unknown start, or discard a known target on a transport failure.
      if (recovering && current() && [-32600,-32602].includes(error.code) &&
          /thread not found|no rollout found/i.test(error.message) && store.get('session','active')?.id===previous.id) {
        store.put('psm-upgrade',previous.id,{phase:'target_absent',previousTarget:intent.newId})
        return
      }
      throw error
    }
    if (target.thread?.id !== intent.newId || target.thread.cwd !== app.cwd || !current() || this.pending(true))
      return
    const next = { ...previous, id: intent.newId, materialized: false, policyVersion: 2 }
    store.transaction(() => {
      if (store.get('session', 'active')?.id !== previous.id) throw Error('Primary changed')
      store.put('router-history', previous.id, { ...previous, retiredAt: Date.now() })
      store.put('session', 'active', next)
      store.put('psm-upgrade', previous.id, { ...intent, phase: 'committed' })
    })
    r.session = next
    this.error = null
    r.publish()
  }
  async close() {
    clearInterval(this.timer)
    await this.running
  }
}
