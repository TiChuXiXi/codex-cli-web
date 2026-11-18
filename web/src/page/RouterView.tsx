import * as React from 'react'
import type { Api } from '../rpc'
import { randomId } from '../randomId'
import type { RouterSnapshot, RouterTask, RouterClarification } from '../../../shared/contracts'
import './router.css'

const labels: Record<string, string> = {
  created: '已创建会话', queued: '已排队', creating: '正在创建会话', submitting: '正在提交', submitted: '已交给 Worker 队列',
  running: '正在执行', awaiting_approval: '等待你的审批', completed: '已完成', failed: '失败',
  interrupted: '已中断', unknown: '结果待核对',
}

export function RouterView({ api, revision, onWorker }: { api: Api, revision: number, onWorker: (id: string) => void }) {
  const [snapshot, setSnapshot] = React.useState<RouterSnapshot | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [acting, setActing] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<'chat' | 'tasks'>('chat')
  const [viewed, setViewed] = React.useState(() => {
    try { return Number(sessionStorage.getItem('codex-router-viewed') ?? 0) || 0 } catch { return 0 }
  })
  const retry = React.useRef<{ text: string, id: string } | null>(null)
  const reads = React.useRef(0)
  const log = React.useRef<HTMLDivElement>(null)
  const stickToEnd = React.useRef(true)

  const refresh = React.useCallback(async () => {
    const read = ++reads.current
    try {
      const value = await api<RouterSnapshot>('router/read')
      if (read === reads.current) setSnapshot(value)
    } catch (cause) {
      if (read === reads.current) setError(cause instanceof Error ? cause.message : '读取 Router 状态失败')
    }
  }, [api])

  React.useEffect(() => { void refresh() }, [refresh, revision])
  React.useEffect(() => {
    const view = log.current
    if (view && stickToEnd.current) view.scrollTop = view.scrollHeight
  }, [tab, snapshot?.messages, snapshot?.clarifications.length])
  React.useEffect(() => {
    if (tab !== 'tasks' || !snapshot?.latestEventId) return
    setViewed(snapshot.latestEventId)
    try { sessionStorage.setItem('codex-router-viewed', String(snapshot.latestEventId)) } catch {}
  }, [tab, snapshot?.latestEventId])

  async function action(operation: () => Promise<unknown>) {
    setError(null)
    try { await operation() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { await refresh() }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!text.trim() || sending || snapshot?.busy || snapshot?.phase !== 'ready') return
    const input = text.trim()
    const id = retry.current?.text === input ? retry.current.id : randomId()
    retry.current = { text: input, id }
    stickToEnd.current = true
    setSending(true)
    await action(async () => {
      await api('router/send', { text: input, requestId: id })
      setText(current => current.trim() === input ? '' : current)
      retry.current = null
    })
    setSending(false)
  }

  async function choose(item: RouterClarification, candidateId?: string) {
    setActing(item.id)
    await action(() => api(candidateId ? 'router/clarifications/confirm' : 'router/clarifications/cancel', {
      id: item.id, revision: item.revision, ...(candidateId ? { candidateId } : {}),
    }))
    setActing(null)
  }

  const ready = snapshot?.phase === 'ready'
  const latestUnseen = (snapshot?.latestEventId ?? 0) > viewed
  return <section className="dsh-codex-router" aria-label="Router">
    <nav className="dsh-codex-router-tabs" aria-label="Router 视图">
      <button type="button" className="dsh-codex-button" aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>对话</button>
      <button type="button" className="dsh-codex-button" aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>
        {latestUnseen ? '任务 · 有更新' : '任务'}
      </button>
      {snapshot?.model && <span className="dsh-codex-router-model">{snapshot.model}</span>}
    </nav>
    {error && <p className="dsh-codex-error" role="alert">{error}</p>}
    {snapshot?.error && <div className="dsh-codex-router-alert" role="status">
      <span>{snapshot.error}</span>
      <button type="button" className="dsh-codex-button" onClick={() => void action(() => api('router/reconnect'))}>重新连接</button>
    </div>}
    {!ready && !snapshot?.error && <p role="status" className="dsh-codex-router-empty">
      {snapshot?.enabled === false ? 'Router 未启用' : '正在连接 Router…'}
    </p>}
    {tab === 'chat' && <>
      <div ref={log} className="dsh-codex-router-scroll dsh-codex-messages" role="log" aria-label="Router 对话"
        onScroll={event => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
          stickToEnd.current = scrollHeight - scrollTop - clientHeight < 96
        }}>
        {ready && !snapshot?.messages.length && <p className="dsh-codex-router-empty">
          可以直接聊天，也可以让 Router 查找已登记项目、续接会话或查询任务。
        </p>}
        {snapshot?.messages.map(message => <article key={message.id} aria-live={message.status === 'streaming' ? 'off' : undefined}
          className={'dsh-codex-message ' + (message.role === 'user' ? 'user' : 'assistant')}>
          <span className="dsh-codex-message-head">{message.role === 'user' ? '你' : 'Router'}</span>
          <div className="dsh-codex-bubble dsh-codex-router-text">{message.text}</div>
          {message.status === 'unknown' && <span className="dsh-codex-router-meta">消息结果待核对</span>}
          {message.status === 'failed' && <span className="dsh-codex-router-meta">Router 回合失败</span>}
        </article>)}
        {snapshot?.clarifications.map(item => <section key={item.id} className="dsh-codex-router-card" aria-label={item.label}>
          <h2>{item.label}</h2>
          {item.original && <details className="dsh-codex-router-original">
            <summary>查看原始请求</summary>
            <p className="dsh-codex-router-text">{item.original}</p>
          </details>}
          <ul className="dsh-codex-router-choices">
            {item.candidates.map(candidate => <li key={candidate.id}>
              <div>
                <strong>{candidate.name}</strong>
                {(candidate.project || candidate.updatedAt) && <div className="dsh-codex-router-meta">
                  {[candidate.project, candidate.updatedAt ? localTime(candidate.updatedAt) : null].filter(Boolean).join(' · ')}
                </div>}
                {candidate.summary && <p className="dsh-codex-router-text">{candidate.summary}</p>}
                {Boolean(candidate.reasons?.length) && <div className="dsh-codex-router-meta">{candidate.reasons?.join(' · ')}</div>}
              </div>
              <button type="button" className="dsh-codex-button" disabled={!ready || acting !== null}
                onClick={() => void choose(item, candidate.id)}>
                {item.kind === 'interrupt' ? '确认中断' : item.kind === 'create' || candidate.id === 'create' ? '确认新建' : '选择'}
              </button>
            </li>)}
          </ul>
          <button type="button" className="dsh-codex-button" disabled={!ready || acting !== null}
            onClick={() => void choose(item)}>取消</button>
        </section>)}
      </div>
      <form className="dsh-codex-composer-wrap dsh-codex-router-composer" onSubmit={submit}>
        <div className="dsh-codex-composer-card">
          <textarea aria-label="给 Router 发送消息" className="dsh-codex-composer-input" rows={2} maxLength={12000}
            placeholder="给 Router 发送消息" value={text} onChange={event => setText(event.target.value)}/>
          <div className="dsh-codex-composer-row dsh-codex-router-actions">
            {snapshot?.busy && <span role="status" className="dsh-codex-router-meta">Router 正在回复…</span>}
            <button type="submit" className="dsh-codex-button primary"
              disabled={!ready || !text.trim() || snapshot?.busy || sending}>发送</button>
          </div>
        </div>
      </form>
    </>}
    {tab === 'tasks' && <div className="dsh-codex-router-scroll dsh-codex-router-tasks" aria-label="Router 任务">
      {snapshot?.tasks.length === 0 && <p className="dsh-codex-router-empty">暂无已派发任务</p>}
      {snapshot?.tasks.map(task => <TaskCard key={task.id} task={task} onWorker={onWorker}
        onDismiss={ready ? () => action(() => api('router/tasks/dismiss-unknown', {
          dispatchId: task.id, updatedAt: task.updatedAt, confirmed: true,
        })) : undefined}/>)}
    </div>}
  </section>
}

function localTime(time: number) {
  return new Date(time).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

function TaskCard({ task, onWorker, onDismiss }: {
  task: RouterTask, onWorker: (id: string) => void, onDismiss?: () => Promise<void>,
}) {
  const [confirm, setConfirm] = React.useState(false)
  return <article className="dsh-codex-router-card">
    <h2>{task.project}</h2>
    <div className="dsh-codex-router-meta">{labels[task.status] ?? task.status} · {localTime(task.updatedAt)}</div>
    {task.summary && <p className="dsh-codex-router-text">{task.summary}</p>}
    {task.error && <p className="dsh-codex-router-text">{task.error}</p>}
    {task.threadId && <button type="button" className="dsh-codex-button" onClick={() => onWorker(task.threadId!)}>
      {task.status === 'awaiting_approval' ? '打开会话处理审批' : '打开 Worker 会话'}
    </button>}
    {task.status === 'unknown' && onDismiss && (confirm
      ? <div className="dsh-codex-router-alert">
        <span>确认已核对 Worker。关闭此任务会恢复队列，并保留任务记录。</span>
        <button type="button" className="dsh-codex-button" onClick={() => {
          setConfirm(false)
          void onDismiss()
        }}>确认关闭</button>
        <button type="button" className="dsh-codex-button" onClick={() => setConfirm(false)}>取消</button>
      </div>
      : <button type="button" className="dsh-codex-button" onClick={() => setConfirm(true)}>已核对，关闭任务</button>)}
  </article>
}
