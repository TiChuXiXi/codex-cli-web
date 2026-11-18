import * as React from 'react'
import type { Api } from '../rpc'
import { randomId } from '../randomId'
import type { RouterSnapshot, RouterTask, RouterClarification } from '../../../shared/contracts'
import { Message } from './ItemCard'
import { Icon } from '../components/Icon'
import './router.css'

const labels: Record<string, string> = {
  created: '已创建会话', queued: '已排队', creating: '正在创建会话', submitting: '正在提交', submitted: '已交给 Worker 队列',
  running: '正在执行', awaiting_approval: '等待你的审批', awaiting_input: '等待你输入', completed: 'Worker 回合已结束', failed: '失败',
  interrupted: '已中断', unknown: '结果待核对',
}

const receiptLabels: Record<string, string> = {
  pending: '等待 Router 回执', claimed: 'Router 正在汇报', unknown: 'Router 回执待核对', failed: 'Router 回执失败',
}

export function RouterView({ api, revision, onWorker }: { api: Api, revision: number, onWorker: (id: string) => void }) {
  const [snapshot, setSnapshot] = React.useState<RouterSnapshot | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [text, setText] = React.useState(() => {
    try { return sessionStorage.getItem('codex-router-draft') ?? '' } catch { return '' }
  })
  const [showJump, setShowJump] = React.useState(false)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const composing = React.useRef(false)
  const submitting = React.useRef(false)
  const [sending, setSending] = React.useState(false)
  const [acting, setActing] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<'chat' | 'tasks'>('chat')
  const [viewed, setViewed] = React.useState(() => {
    try { return Number(sessionStorage.getItem('codex-router-viewed') ?? 0) || 0 } catch { return 0 }
  })
  const retry = React.useRef<{ text: string, id: string } | null>(null)
  const reads = React.useRef(0)
  const log = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
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
    try { sessionStorage.setItem('codex-router-draft', text) } catch {}
  }, [text])
  React.useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 240) + 'px'
  }, [text, tab])
  React.useLayoutEffect(() => {
    const view = log.current
    if (view && stickToEnd.current) view.scrollTop = view.scrollHeight
  }, [tab, snapshot?.messages, snapshot?.clarifications.length])
  React.useLayoutEffect(() => {
    const view = log.current
    const content = contentRef.current
    if (!view || !content) return
    const follow = () => { if (stickToEnd.current) view.scrollTop = view.scrollHeight }
    const observer = new ResizeObserver(follow)
    observer.observe(view)
    observer.observe(content)
    content.addEventListener('load', follow, true)
    return () => { observer.disconnect(); content.removeEventListener('load', follow, true) }
  }, [tab])
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

  async function submit() {
    if (!text.trim() || submitting.current || snapshot?.busy || snapshot?.phase !== 'ready') return
    submitting.current = true
    const input = text.trim()
    const id = retry.current?.text === input ? retry.current.id : randomId()
    retry.current = { text: input, id }
    stickToEnd.current = true
    setShowJump(false)
    setSending(true)
    await action(async () => {
      await api('router/send', { text: input, requestId: id })
      setText(current => current.trim() === input ? '' : current)
      retry.current = null
    })
    submitting.current = false
    setSending(false)
    inputRef.current?.focus()
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
    </nav>
    {error && <p className="dsh-codex-error" role="alert">{error}</p>}
    {snapshot?.error && <div className="dsh-codex-router-alert" role="status">
      <span>{snapshot.error}</span>
      <button type="button" className="dsh-codex-button" onClick={() => void action(() => api('router/reconnect'))}>重新连接</button>
    </div>}
    {!ready && !snapshot?.error && <p role="status" className="dsh-codex-router-empty">
      {snapshot?.enabled === false ? 'Router 未启用' : '正在连接 Router…'}
    </p>}
    {snapshot?.receiptLimited && <p role="status" className="dsh-codex-router-meta">已达到自动回执限额，待回执任务将在额度恢复后处理。</p>}
    {tab === 'chat' && <>
      <div className="dsh-codex-messages-wrap">
      <div ref={log} className="dsh-codex-messages" role="log" aria-label="Router 对话"
        onScroll={event => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
          stickToEnd.current = scrollHeight - scrollTop - clientHeight <= 32
          setShowJump(!stickToEnd.current)
        }}>
        {ready && !snapshot?.messages.length && <p className="dsh-codex-router-empty">
          可以直接聊天，也可以让 Router 查找已登记项目、续接会话或查询任务。
        </p>}
        <div ref={contentRef} className="dsh-codex-message-content">
        {snapshot?.messages.map(message => <React.Fragment key={message.id}>
          <Message api={api} kind={message.role} label={message.role === 'user' ? '你' : 'Router'} text={message.text}/>
          {message.status === 'unknown' && <span className="dsh-codex-router-meta">消息结果待核对</span>}
          {message.status === 'failed' && <span className="dsh-codex-router-meta">Router 回合失败</span>}
        </React.Fragment>)}
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
      </div>
      {showJump && <button type="button" className="dsh-codex-jump" aria-label="回到底部" onClick={() => {
        stickToEnd.current = true
        setShowJump(false)
        log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
      }}><Icon name="arrowDown" size={16}/></button>}
      </div>
      {snapshot?.busy && <div role="status" className="dsh-codex-running-bar">
        <Icon name="loader" size={16} className="dsh-codex-running-spinner"/>Router 正在回复…
      </div>}
      <form className="dsh-codex-composer-wrap" onSubmit={event => { event.preventDefault(); void submit() }}>
        <div className="dsh-codex-composer-card" aria-busy={sending || snapshot?.busy}>
          <textarea ref={inputRef} aria-label="给 Router 发送消息" className="dsh-codex-composer-input" rows={1} maxLength={12000}
            placeholder="给 Router 发送消息" value={text} disabled={!ready}
            onChange={event => setText(event.target.value)}
            onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) {
                event.preventDefault()
                void submit()
              }
            }}/>
          <div className="dsh-codex-composer-row">
            <div className="dsh-codex-composer-spacer"/>
            <div className="dsh-codex-composer-trailing">
            {snapshot?.model && <span className="dsh-codex-model-trigger" title={snapshot.model}>
              <Icon name="model" size={16}/><span className="dsh-codex-model-label">{snapshot.model === 'gpt-6.1-terra' ? 'GPT-6.1 Terra' : snapshot.model}</span>
            </span>}
            <button type="submit" className="dsh-codex-send" aria-label="发送" title="发送"
              disabled={!ready || !text.trim() || snapshot?.busy || sending}><Icon name="arrowUp" size={16}/></button>
            </div>
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
    {task.receiptStatus && receiptLabels[task.receiptStatus] && <div className="dsh-codex-router-meta">{receiptLabels[task.receiptStatus]}</div>}
    {task.summary && <p className="dsh-codex-router-text">{task.summary}</p>}
    {task.error && <p className="dsh-codex-router-text">{task.error}</p>}
    {task.threadId && <button type="button" className="dsh-codex-button" onClick={() => onWorker(task.threadId!)}>
      {task.status === 'awaiting_approval' ? '打开会话处理审批' : task.status === 'awaiting_input' ? '打开会话回答' : '打开 Worker 会话'}
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
