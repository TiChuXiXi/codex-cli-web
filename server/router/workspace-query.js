import { checkProject, shortText } from './projects.js'
import { redact } from './psm-index.js'
import { targetLabelMatches } from './matching.js'
import { renderWorkspacePage } from '../../shared/router-expression.js'

const labels = {running:'执行中', awaiting_input:'等待输入', awaiting_approval:'等待审批', completed:'回合结束',
  failed:'失败', submitted:'已进入原生队列', queued:'排队中', interrupted:'已中断', cancelled:'已取消', unknown:'待核对'}
const clean = (value, size = 100) => shortText(redact(String(value ?? ''))
  .replace(/```[\s\S]*?(?:```|$)/g,'（代码省略）')
  .replace(/(?:^|\s)(?:\/[\w.-]+\/|[A-Za-z]:\\)(?:[^\s，。；]+)/g,' （路径省略）'),size)

async function visibleThread(router, project, id) {
  try {
    const thread = await router.hub.psmMetadata(id)
    return thread?.id === id && thread.cwd === project.cwd && !thread.ephemeral && !thread.parentThreadId ? thread : null
  } catch { return null }
}
const date = stamp => new Date(stamp).toISOString().slice(0,16).replace('T',' ') + ' UTC'

// Recheck the identity actually used for a projection. A reused display name or project ID is insufficient.
export function currentAccess(router, guards) {
  return guards.every(({id,identity,birth,uid,entry,revision}) => {
    const project = router.projects.get(id) ?? (router.psm.preference.enabled && router.store.get('psm-read-grant',id))
    if (!project || project.identity !== identity || project.birth !== birth) return false
    if (uid && (!router.psm.preference.enabled || router.psm.identity(project,false) !== uid)) return false
    if (!entry) return true
    const row = router.store.get('psm-entry',entry)
    return row?.state === 'active' && row.uid === uid && row.revision === revision
  })
}

export async function verifyWorkspaceAccess(router, guards) {
  for (const id of new Set(guards.map(guard=>guard.id))) {
    const p = router.projects.get(id) ?? router.store.get('psm-read-grant',id)
    if (!await checkProject(p).catch(() => null)) return false
  }
  return currentAccess(router,guards)
}

async function overview(router, project, uid, entries) {
  if (!uid) return {text:'暂无可靠项目简介。'}
  const rows = entries.filter(e => e.uid === uid && e.projectId === project.id && e.state === 'active')
    .sort((a,b) => b.updatedAt - a.updatedAt)
  const confirmed = rows.find(e => !e.threadId && e.kind === 'description' && e.level === 'user_confirmed')
  if (confirmed) return {text:'已确认：' + clean(confirmed.value), entry:confirmed}
  for (const row of rows) {
    if (!['description','topic'].includes(row.kind) || row.id.startsWith('choice-')) continue
    if (row.threadId) {
      const source = await router.psm.sync?.db.call('source',row.threadId)
      if (source?.project !== uid || !['active','archived'].includes(source.state) || !await visibleThread(router,project,row.threadId)) continue
    }
    if (row.level !== 'user_confirmed') {
      if (!row.evidenceRef?.startsWith('msg:')) continue
      const ref = await router.psm.get(row.evidenceRef,false).catch(() => null)
      if (ref?.projectId !== project.id || !ref.text || !ref.text.includes(row.value)) continue
    }
    return {text:'历史记录涉及：' + clean(row.value), entry:row}
  }
  const topics = await router.psm.sync?.db.call('recentTopics',uid) ?? []
  const current = await Promise.all(topics.map(t => visibleThread(router,project,t.id)))
  const titles = [...new Set(current.map(thread => clean(thread?.name,45)).filter(Boolean))]
  return {text:titles.length ? '历史会话涉及：' + titles.join('、') : '暂无可靠项目简介。'}
}

export async function queryWorkspace(router, intent, message) {
  const directory = await router.hub.workspaceProjects(router.session.id).catch(() => ({rows:[],complete:false}))
  const rows = await router.projectRows(directory.rows ?? directory)
  const allowed = router.psm.preference.enabled ? await router.psm.allowed(undefined,false) : new Map()
  const byId = new Map([...allowed].map(([uid,p]) => [p.id,{uid,p}]))
  for (const {p} of byId.values()) if (!rows.some(row => row.id === p.id))
    rows.push({id:p.id,name:p.name,aliases:p.aliases})
  let selected = rows
  if (intent.scope === 'focus' || intent.scope === 'named') {
    const names = intent.scope === 'focus' ? [message.routing.focus?.projectId] : intent.projects
    const matches = names.map(name => name ? rows.filter(row => targetLabelMatches(name,[row.id,row.name,...row.aliases])) : [])
    if (!matches.length || matches.some(group => group.length !== 1)) return {text:'请在查询中注明可见的项目名称。',guards:[]}
    selected = [...new Set(matches.flat())]
  }
  const lines = []
  const tasks = ['tasks','activity'].includes(intent.view) ? router.dispatcher.list(-1) : []
  const entries = intent.view === 'overview' && allowed.size ? router.store.list('psm-entry') : []
  let partial = directory.complete === false
  for (const row of selected) {
    const p = router.projects.get(row.id) ?? byId.get(row.id)?.p
    const name = clean(row.name)
    if (!p) {
      if (row.requiresApproval && ['overview','projects'].includes(intent.view)) lines.push({text:name+'（待授权）'})
      continue
    }
    if (!await checkProject(p).catch(() => null)) { partial = true; continue }
    const uid = byId.get(p.id)?.uid
    const guard = {id:p.id,identity:p.identity,birth:p.birth}
    if (!router.projects.has(p.id) && uid) guard.uid = uid
    if (intent.view === 'projects') lines.push({text:name,guard})
    if (intent.view === 'overview') {
      const info = await overview(router,p,uid,entries).catch(() => {
        partial = true
        return {text:'暂无可靠项目简介，历史索引暂不可用。'}
      })
      lines.push({text:name+'：'+info.text,guard:{...guard,uid,entry:info.entry?.id,revision:info.entry?.revision}})
    }
    if (intent.view === 'history' && uid) {
      if (!router.psm.sync) { partial = true; continue }
      const hits = await router.psm.search({query:intent.topic,projectId:p.id,limit:25},false).catch(() => null)
      if (!hits) { partial = true; continue }
      const seen = new Set()
      for (const hit of hits) {
        if (!hit.threadId || seen.has(hit.threadId) || !['active','archived'].includes(hit.state)) continue
        const source = await router.psm.sync.db.call('source',hit.threadId)
        if (source?.project !== uid || !['active','archived'].includes(source.state)) continue
        if (!await visibleThread(router,p,hit.threadId)) continue
        const ref = await router.psm.get(hit.ref,false).catch(() => null)
        if (ref?.projectId !== p.id || ref.threadId !== hit.threadId || ref.state === 'revoked') continue
        seen.add(hit.threadId)
        const evidence = clean(ref.result || ref.value || hit.text,140)
        lines.push({text:name+' · '+clean(source.title || '未命名会话')+'（'+(source.state === 'archived'?'已归档':'历史记录')+'）：'+evidence,
          guard:{...guard,uid,...(hit.ref.startsWith('entry:') && {entry:ref.id,revision:ref.revision})},at:hit.updatedAt})
      }
      if (hits.length === 25) partial = true
    }
    if (intent.view === 'tasks' || intent.view === 'activity') {
      let last = row.updatedAt ?? 0
      let activity = last ? '会话有更新' : ''
      for (const task of tasks.filter(t => t.projectId === p.id)) {
        const pin = task.psmProjectUid ?? router.store.get('psm-thread',task.threadId ?? '')?.uid
        if (pin && router.psm.preference.enabled && pin !== uid) continue
        // Legacy tasks have no directory identity. Verify their persisted native thread before showing text.
        if (!uid || !task.psmProjectUid) {
          if (!task.threadId) continue
          if (!await visibleThread(router,p,task.threadId)) continue
        }
        if (task.updatedAt && task.updatedAt >= last) {
          last = task.updatedAt
          activity = clean(task.instruction || '任务有更新',80)
        }
        const owner = router.store.command(task.id)?.ownerId
        const state = (owner && router.store.get('task',owner)?.status) || task.status
        const matches = !intent.topic || [task.threadName,task.instruction].some(text=>text?.toLowerCase().includes(intent.topic.toLowerCase()))
        if (intent.view === 'tasks' && matches && (intent.status === 'any' || state === intent.status))
          lines.push({text:name+' · '+clean(task.instruction || task.threadName || '任务',80)+' — '+(labels[state] ?? '待核对'),guard,at:task.updatedAt})
      }
      if (intent.view === 'activity' && last) lines.push({text:name+' · '+activity+' · '+date(last),at:last,guard})
    }
  }
  if (['projects','overview'].includes(intent.view)) lines.sort((a,b)=>a.text.localeCompare(b.text,'zh-CN'))
  else lines.sort((a,b) => (b.at ?? 0)-(a.at ?? 0))
  const profile = router.expressionSettings().profile
  const result = renderWorkspacePage(intent,lines,{partial,psmEnabled:router.psm.preference.enabled,profile,channel:message.origin?'wechat':'web'})
  if (!await verifyWorkspaceAccess(router,result.guards)) return {text:'项目访问范围已变化，请重新查询。',guards:[]}
  return result
}
