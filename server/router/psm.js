import { createHash, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { realpath, rm } from 'node:fs/promises'
import { HubError } from '../codex/hub.js'
import { checkProject, loadRouterProjects } from './projects.js'
import { redact, searchTerms, visibleText } from './psm-index.js'
import { PsmSync } from './psm-sync.js'

const bad = (message) => new HubError('codex-cli/psm', message)
const kinds = new Set(['description', 'alias', 'topic', 'decision', 'constraint', 'progress'])
const fingerprint = (text) => createHash('sha256').update(text).digest('hex')
const termsMatch = (value, terms) => terms.every((word) => value.includes(word))
const refOf = (hit) =>
  'msg:' + Buffer.from(JSON.stringify([hit.thread, hit.turn, hit.item, hit.part, hit.hash])).toString('base64url')

export class ProjectSessionMemory {
  constructor(router) {
    this.router = router
    this.store = router.store
    this.preference = this.store.get('settings', 'psm') ?? { enabled: true, paused: false }
    this.controls = Promise.resolve()
    if (this.preference.enabled) {
      try {
        this.open()
        this.controls = this.finishPurges().catch(() => {
          this.sync.error = '数据清除等待重试'
        })
      } catch {
        this.startError = 'PSM 后台服务不可用'
      }
    }
  }
  open() {
    if (this.sync) return
    this.sync = new PsmSync({
      hub: this.router.hub,
      bus: this.router.bus,
      path: join(this.router.directory, 'psm-index.sqlite'),
      routerPath: join(this.router.directory, 'router.sqlite'),
      registered: () => [...this.router.projects.values()].map((p) => p.cwd),
      paused: this.preference.paused,
      projectFor: (cwd) => this.discover(cwd),
      pin: (id, uid) => this.bindSource(id, uid),
    })
  }
  async bindSource(id, uid) {
    if (this.store.get('psm-forgotten',fingerprint(id))) return null
    const old = this.store.get('psm-thread', id)
    if (!old) {
      this.store.put('psm-thread', id, {uid})
      return uid
    }
    if (old.uid === uid) return uid
    const records = this.store.list('psm-project')
    const previous = records.find(row => row.uid === old.uid)
    const next = records.find(row => row.uid === uid)
    if (!previous || !next || previous.cwd === next.cwd || previous.identity !== next.identity || previous.birth !== next.birth) return null
    // A native Thread following the same filesystem object corroborates a move.
    // An inaccessible mount or two existing roots is insufficient evidence.
    try { await realpath(previous.cwd); return null } catch (error) { if (error.code !== 'ENOENT') return null }
    const native = await this.router.hub.psmMetadata(id)
    if (native.cwd !== next.cwd || native.ephemeral || native.parentThreadId) return null
    if (this.store.db.prepare("SELECT 1 FROM router_records WHERE kind IN ('psm-entry','psm-thread') AND json_extract(value,'$.uid')=? LIMIT 1").get(uid)) return null
    this.store.transaction(() => {
      this.store.db.prepare("DELETE FROM router_records WHERE kind='psm-project' AND id=?").run(previous.key)
      this.store.put('psm-project', next.key, {...next,uid:old.uid,previousPaths:[...(previous.previousPaths ?? []),previous.cwd]})
    })
    return old.uid
  }
  async finishPurges() {
    for (const row of this.store.list('psm-exclusion')) {
      if (!row.pending) continue
      await this.sync.db.call('purge', row.uid)
      this.store.put('psm-exclusion', row.key, { excluded: true })
      this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    }
  }
  async discover(path) {
    try {
      const cwd = await realpath(path)
      const project = (
        await loadRouterProjects([{ id: 'source', name: basename(cwd), cwd }], this.router.directory)
      ).get('source')
      return this.identity(project)
    } catch {
      return null
    }
  }
  identity(project) {
    const key = fingerprint(JSON.stringify([project.cwd, project.identity, project.birth]))
    if (this.store.get('psm-exclusion', key)) return null
    let record = this.store.get('psm-project', key)
    if (!record)
      record = this.store.put('psm-project', key, {
        uid: randomUUID(),
        key,
        cwd: project.cwd,
        identity: project.identity,
        birth: project.birth,
      })
    return record.uid
  }
  async allowed(projectId) {
    const result = new Map()
    const projects = new Map(this.store.list('psm-read-grant').map((project) => [project.id, project]))
    for (const [id, project] of this.router.projects) projects.set(id, project)
    for (const project of projects.values()) {
      if (projectId && projectId !== project.id) continue
      if (await checkProject(project).catch(() => null)) {
        const uid = this.identity(project)
        if (uid) result.set(uid, project)
      }
    }
    return result
  }
  async status() {
    if (!this.sync)
      return { ...this.preference, phase: this.preference.enabled ? 'failed' : 'disabled', error: this.startError }
    try {
      return {
        ...this.preference,
        ...(await this.sync.status()),
        policy: this.router.app?.policyVersion,
        migration: this.router.upgrade?.error ?? (this.router.session?.policyVersion === 2 ? 'ready' : 'waiting'),
      }
    } catch {
      return { ...this.preference, phase: 'failed', error: '索引数据库不可用' }
    }
  }
  control(payload = {}) {
    const action = this.controls.then(() => this.change(payload))
    this.controls = action.catch(() => {})
    return action
  }
  async change({ action, projectId, confirmed }) {
    if (!['enable', 'disable', 'pause', 'resume', 'retry', 'sync', 'rebuild', 'purge'].includes(action))
      throw bad('无效的 PSM 操作')
    if (action === 'disable') {
      this.preference = this.store.put('settings', 'psm', { enabled: false, paused: false })
      await this.sync?.close()
      this.sync = null
      return this.status()
    }
    if (action !== 'enable' && !this.preference.enabled) throw bad('请先启用 PSM')
    if (action === 'enable' || action === 'pause' || action === 'resume')
      this.preference = this.store.put('settings', 'psm', { enabled: true, paused: action === 'pause' })
    if (this.sync?.db.stopped && action === 'retry') {
      await this.sync.close()
      this.sync = null
    }
    this.open()
    if (action === 'retry') {
      await this.finishPurges()
      await this.sync.db.call('verify')
    }
    if (action === 'pause') await this.sync.pause()
    else if (action === 'purge' || action === 'rebuild') {
      if (confirmed !== true) throw bad('请确认数据操作')
      let pair
      if (action === 'purge' && typeof projectId === 'string') {
        if (projectId.startsWith('source:')) {
          const saved = this.store.list('psm-project').find(row => 'source:' + row.uid === projectId)
          if (saved) pair = [saved.uid, saved]
        } else {
          pair = [...await this.allowed(projectId)].find(([, project]) => project.id === projectId)
        }
      }
      if (action === 'purge' && !pair) throw bad('项目不可用')
      await this.sync.pause()
      try {
        if (action === 'rebuild') {
          await this.sync.close()
          this.sync = null
          const file = join(this.router.directory, 'psm-index.sqlite')
          for (const suffix of ['', '-wal', '-shm']) await rm(file + suffix, { force: true })
          this.open()
        } else {
          const [uid, project] = pair
          const key = fingerprint(JSON.stringify([project.cwd, project.identity, project.birth]))
          this.store.db.exec('PRAGMA secure_delete=ON')
          this.store.transaction(() => {
            for (const kind of ['psm-entry', 'psm-revision'])
              this.store.db
                .prepare("DELETE FROM router_records WHERE kind=? AND json_extract(value,'$.uid')=?")
                .run(kind, uid)
            this.store.db
              .prepare(
                "DELETE FROM router_records WHERE kind='clarification' AND json_extract(value,'$.proposal.uid')=?",
              )
              .run(uid)
            const pins=this.store.db.prepare("SELECT id FROM router_records WHERE kind='psm-thread' AND json_extract(value,'$.uid')=?").all(uid)
            for (const {id} of pins) this.store.put('psm-forgotten',fingerprint(id),true)
            this.store.db.prepare("DELETE FROM router_records WHERE kind='psm-thread' AND json_extract(value,'$.uid')=?").run(uid)
            this.store.db.prepare("DELETE FROM router_records WHERE kind='psm-read-grant' AND json_extract(value,'$.cwd')=? AND json_extract(value,'$.identity')=?").run(project.cwd,project.identity)
            this.store.put('psm-exclusion', key, { key, uid, pending: true })
            this.store.db.prepare("DELETE FROM router_records WHERE kind='psm-project' AND id=?").run(key)
          })
          await this.finishPurges()
        }
      } finally {
        if (!this.preference.paused) this.sync?.resume()
      }
    } else if (!this.preference.paused) this.sync.resume()
    return this.status()
  }
  requireEnabled() {
    if (!this.preference.enabled || !this.sync) throw bad('PSM 未启用，可使用现有项目和会话查找')
  }
  async targetIssue(project, id) {
    if (!this.preference.enabled || !this.sync) return null
    const pin = this.store.get('psm-thread', id)
    const uid = this.identity(project)
    if (!uid) return null
    if (pin && pin.uid !== uid) return '会话的原项目身份已变化'
    const source = await this.sync.db.call('source', id).catch(() => null)
    return source && source.state !== 'active' ? '目标会话已失效或归档' : null
  }
  async source(threadId, allowed) {
    const src = await this.sync.db.call('source', threadId)
    if (!src || !allowed.has(src.project)) throw bad('来源不可见或尚未索引')
    return src
  }
  async search({ query, projectId, limit = 12 }) {
    this.requireEnabled()
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      query.length > 512 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 25
    )
      throw bad('无效的检索参数')
    const allowed = await this.allowed(projectId)
    const words = searchTerms(query).split(' ').filter(Boolean)
    if (!words.length) return []
    const refs = await this.sync.db.call('factHits', { query, projects: [...allowed.keys()], limit })
    const results = []
    for (const ref of refs.filter((r) => r.id.startsWith('entry:'))) {
      const row = this.store.get('psm-entry', ref.id.slice(6))
      if (!row) continue
      if (row.state !== 'active' || !allowed.has(row.uid)) continue
      const src = row.threadId && (await this.sync.db.call('source', row.threadId))
      results.push({
        ref: 'entry:' + row.id,
        projectId: allowed.get(row.uid).id,
        threadId: row.threadId,
        kind: row.kind,
        text: row.value,
        level: row.level,
        updatedAt: row.updatedAt,
        revision: row.revision,
        state: src?.state ?? (row.threadId ? 'missing' : 'active'),
      })
    }
    results.sort(
      (a, b) =>
        Number(b.level === 'user_confirmed') - Number(a.level === 'user_confirmed') || b.updatedAt - a.updatedAt,
    )
    const confirmed = results.filter((row) => row.level === 'user_confirmed')
    const other = results.filter((row) => row.level !== 'user_confirmed')
    const experiences = []
    for (const ref of refs.filter((r) => r.id.startsWith('task:'))) {
      const task = this.store.get('task', ref.id.slice(5))
      if (!task) continue
      const uid = task.psmProjectUid ?? this.store.get('psm-thread', task.threadId ?? '')?.uid
      if (!allowed.has(uid) || allowed.get(uid).id !== task.projectId) continue
      const text = redact(task.instruction ?? '')

      const state = task.threadId && (await this.sync.db.call('source', task.threadId))?.state
      experiences.push({
        ref: 'task:' + task.id,
        level: 'router_observed',
        projectId: task.projectId,
        threadId: task.threadId,
        updatedAt: task.updatedAt,
        executionStatus: task.status,
        text: text.slice(0, 320),
        state: state === 'active' && !task.psmProjectUid ? 'unverified' : state || 'missing',
      })
      if (experiences.length >= limit) break
    }
    const names = [...allowed.values()]
      .filter((p) => termsMatch(searchTerms([p.name, ...p.aliases].join(' ')), words))
      .map((p) => ({
        ref: 'project:' + p.id,
        projectId: p.id,
        level: 'source_verified',
        text: p.name,
        state: 'active',
      }))
    const hits = await this.sync.db.call('search', { query, projects: [...allowed.keys()], limit })
    const snippet = (body) => {
      const text = body.toLowerCase()
      const offset = words.map((word) => text.indexOf(word)).find((pos) => pos >= 0) ?? 0
      const start = Math.max(0, offset - 120)
      return (start ? '…' : '') + body.slice(start, start + 500)
    }
    return [
      ...confirmed,
      ...experiences,
      ...other,
      ...names,
      ...hits.map((hit) => ({
        ref: refOf(hit),
        projectId: allowed.get(hit.project).id,
        threadId: hit.thread,
        turnId: hit.turn,
        itemId: hit.item,
        title: hit.title,
        text: snippet(hit.body),
        level: 'source_verified',
        state: hit.state,
        updatedAt: hit.stamp == null ? null : hit.stamp * 1000,
      })),
    ]
      .slice(0, limit)
      .map((row) => ({
        ...row,
        resumeCandidate: Boolean(
          row.threadId && row.state === 'active' && this.router.projects.has(row.projectId),
        ),
      }))
  }
  async get(ref) {
    this.requireEnabled()
    if (typeof ref !== 'string' || ref.length > 2048) throw bad('无效的证据引用')
    const allowed = await this.allowed()
    if (ref.startsWith('project:')) {
      const id = ref.slice(8),
        project = [...allowed.values()].find((p) => p.id === id)
      if (!project) throw bad('项目尚未授权')
      return { projectId: id, name: project.name, aliases: project.aliases }
    }
    if (ref.startsWith('entry:')) {
      const row = this.store.get('psm-entry', ref.slice(6))
      if (!row || !allowed.has(row.uid)) throw bad('条目不可见')
      return { ...row, projectId: allowed.get(row.uid).id }
    }
    if (ref.startsWith('task:')) {
      const task = this.store.get('task', ref.slice(5))
      if (!task || !allowed.has(task.psmProjectUid ?? this.store.get('psm-thread', task.threadId ?? '')?.uid))
        throw bad('任务不可见')
      return {
        projectId: task.projectId,
        threadId: task.threadId,
        turnId: task.turnId,
        executionStatus: task.status,
        instruction: redact(task.instruction ?? ''),
        result: redact(this.store.get('message', 'worker-result:' + task.id)?.text ?? task.summary ?? '').slice(
          0,
          2000,
        ),
      }
    }
    if (!ref.startsWith('msg:')) throw bad('无效的来源引用')
    const [id, turnId, itemId, part, hash] = JSON.parse(Buffer.from(ref.slice(4), 'base64url').toString())
    if (typeof id !== 'string' || !Number.isSafeInteger(part) || part < 0) throw bad('无效的消息位置')
    const src = await this.source(id, allowed)
    const thread = await this.router.hub.psmMetadata(id)
    if (
      thread.ephemeral ||
      thread.parentThreadId ||
      (await this.discover(thread.cwd)) !== src.project ||
      !['active', 'archived'].includes(src.state)
    )
      throw bad('原始来源已失效')
    let cursor
    const seen = new Set()
    do {
      const page = await this.router.hub.psmTurns(id, cursor)
      const item = page.data.find((t) => t.id === turnId)?.items.find((i) => i.id === itemId)
      if (item) {
        const text = Array.from(visibleText(item))
          .slice(part * 2016, part * 2016 + 2048)
          .join('')
        if (!text || fingerprint(text) !== hash) break
        return {
          ref,
          text,
          projectId: allowed.get(src.project).id,
          threadId: id,
          turnId,
          itemId,
          state: src.state,
        }
      }
      cursor = page.nextCursor
      if (seen.has(cursor)) break
      seen.add(cursor)
    } while (cursor)
    throw bad('证据内容已变化，请重新同步')
  }
  async proposal(name, args, source) {
    this.requireEnabled()
    let old = name === 'psm_save' ? null : await this.get('entry:' + args.entryId)
    if (old && (old.revision !== args.revision || old.state !== 'active')) throw bad('条目已变化，请重新读取')
    const projectId = args.projectId ?? old?.projectId
    if (typeof projectId !== 'string') throw bad('缺少项目')
    const [pair] = await this.allowed(projectId)
    if (!pair || pair[1].id !== projectId) throw bad('项目未授权')
    const [uid] = pair,
      threadId = Object.hasOwn(args,'threadId') ? args.threadId : (old?.uid === uid ? old.threadId : null) ?? null
    if (name !== 'psm_remove' && threadId && (await this.source(threadId, new Map([pair]))).state !== 'active') throw bad('目标会话不可用')
    const kind = args.kind ?? old?.kind
    const raw = args.value ?? old?.value
    if (typeof raw !== 'string' || raw.length > 1200) throw bad('无效的语义文本')
    const value = redact(raw.trim())
    if (!kinds.has(kind) || !value || value.length > 1200) throw bad('无效的语义条目')
    if (!old && ['alias', 'topic', 'description'].includes(kind)) {
      const visible = await this.allowed()
      const key = value.normalize('NFKC').toLowerCase()
      const matches = this.store
        .list('psm-entry')
        .filter(
          (row) =>
            row.state === 'active' &&
            row.kind === kind &&
            visible.has(row.uid) &&
            (kind === 'description'
              ? row.uid === uid && row.threadId === threadId
              : row.value.normalize('NFKC').toLowerCase() === key),
        )
      old = matches.find((row) => row.uid === uid && row.threadId === threadId) ?? matches[0]
    }
    const evidenceRef = args.evidenceRef
    if (evidenceRef) {
      const evidence = await this.get(evidenceRef)
      if (evidence.projectId !== projectId || (threadId && evidence.threadId && evidence.threadId !== threadId))
        throw bad('证据与目标不符')
    }
    return {
      id: old?.id ?? fingerprint(JSON.stringify([source.requestId,uid,threadId,kind,value])),
      uid,
      projectId,
      threadId,
      kind,
      value,
      previous: old?.revision ?? 0,
      state: name === 'psm_remove' ? 'revoked' : 'active',
      evidenceRef: evidenceRef ?? source.id,
      requestId: source.requestId,
    }
  }
  apply(proposal, level, confirmation) {
    this.requireEnabled()
    const project =
      this.router.projects.get(proposal.projectId) ?? this.store.get('psm-read-grant', proposal.projectId)
    if (!project || this.identity(project) !== proposal.uid) throw bad('项目身份已变化')
    const { previous, ...record } = proposal
    const existing = this.store.get('psm-entry', record.id)
    if ((existing?.revision ?? 0) !== previous) throw bad('修订冲突')
    if (existing?.level === 'user_confirmed' && level !== 'user_confirmed') throw bad('修改已确认记忆需要用户确认')
    const row = { ...record, level, confirmation, revision: previous + 1, updatedAt: Date.now() }
    this.store.transaction(() => {
      this.store.put('psm-entry', row.id, row)
      this.store.put('psm-revision', row.id + ':' + row.revision, row)
    })
    this.projectEntry(row.id)
    return { ref: 'entry:' + row.id, revision: row.revision }
  }
  projectEntry(id) {
    this.sync?.db.call('projectFacts', { kind: 'psm-entry', id }).catch(() => {
      if (this.sync) this.sync.error = '记忆检索待重新同步'
    })
  }
  confirmedTopic(project, threadId) {
    if (!this.preference.enabled) return ''
    const uid = this.identity(project)
    if (!uid) return ''
    // Automatic choice records contain the original user instruction, not a title.
    const row = this.store.list('psm-entry').find(entry => entry.uid === uid && entry.threadId === threadId &&
      entry.projectId === project.id && entry.kind === 'topic' && entry.state === 'active' &&
      entry.level === 'user_confirmed' && !entry.id.startsWith('choice-'))
    return row?.value ?? ''
  }

  recordChoice({ uid, projectId, threadId, row }) {
    const value = redact(row.original).slice(0, 1200)
    const id = 'choice-' + fingerprint(value.normalize('NFKC').trim().toLowerCase())
    const previous = this.store.get('psm-entry', id)
    const entry = {
      id,
      kind: 'topic',
      value,
      projectId,
      uid,
      threadId,
      level: 'user_confirmed',
      confirmation: row.id,
      evidenceRef: 'user:' + row.requestId,
      state: 'active',
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    }
    this.store.put('psm-entry', id, entry)
    this.store.put('psm-revision', id + ':' + entry.revision, entry)
    queueMicrotask(() => this.projectEntry(id))
  }
  async profile(projectId) {
    this.requireEnabled()
    const allowed = await this.allowed()
    const projects = [...allowed.values()].map((p) => ({ id: p.id, name: p.name }))
    for (const source of this.store.list('psm-project')) {
      if (!allowed.has(source.uid)) projects.push({id:'source:'+source.uid, name:source.cwd+'（仅清理索引）'})
    }
    const pair = [...allowed].find(([, p]) => p.id === projectId)
    const entries = pair
      ? this.store.list('psm-entry').filter((row) => row.uid === pair[0] && row.state === 'active')
      : []
    return { projects, entries }
  }
  async correct(args) {
    const source = { id: 'settings:' + randomUUID() }
    const proposal = await this.proposal(args.remove ? 'psm_remove' : 'psm_update', args, source)
    return this.apply(proposal, 'user_confirmed', source.id)
  }
  async close() {
    await this.controls
    await this.sync?.close()
  }
}
