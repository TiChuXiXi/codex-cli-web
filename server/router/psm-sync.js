import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'

export class IndexWorker {
  constructor(path, routerPath) {
    this.pending = new Map()
    this.serial = 0
    this.worker = new Worker(new URL('./psm-index.js', import.meta.url), {
      workerData: { psmPath: path, routerPath },
      execArgv: [],
    })
    this.worker.on('message', ({ id, result, error }) => {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (error) pending.reject(new Error(error))
      else pending.resolve(result)
    })
    const stop = () => {
      this.stopped = true
      for (const pending of this.pending.values()) pending.reject(new Error('PSM 数据库不可用'))
      this.pending.clear()
    }
    this.worker.on('error', stop)
    this.worker.on('exit', stop)
  }
  call(method, args) {
    if (this.stopped) return Promise.reject(new Error('PSM 数据库不可用'))
    const id = ++this.serial,
      pending = Promise.withResolvers()
    this.pending.set(id, pending)
    this.worker.postMessage({ id, method, args })
    return pending.promise
  }
  async close() {
    await this.worker.terminate()
  }
}

async function pages(read, visit, signal) {
  let cursor
  const seen = new Set()
  do {
    signal.throwIfAborted()
    const page = await read(cursor)
    signal.throwIfAborted()
    if (!Array.isArray(page?.data) || !Object.hasOwn(page, 'nextCursor'))
      throw new Error('Incomplete history page')
    if ((await visit(page.data)) === true) return
    cursor = page.nextCursor
    if (cursor !== null && (typeof cursor !== 'string' || !cursor || seen.has(cursor)))
      throw new Error('Invalid history cursor')
    seen.add(cursor)
  } while (cursor !== null)
}

export class PsmSync {
  constructor({
    hub,
    bus,
    path,
    routerPath,
    projectFor,
    pin,
    registered = () => [],
    paused = false,
    interval = 20 * 60 * 1000,
  }) {
    this.hub = hub
    this.projectFor = projectFor
    this.pin = pin
    this.registered = registered
    this.db = new IndexWorker(path, routerPath)
    this.paused = paused
    this.phase = paused ? 'paused' : 'idle'
    this.discover = true
    this.off = bus.subscribe((event) => this.event(event))
    this.timer = setInterval(() => this.refresh(), interval)
    this.timer.unref()
    this.kick()
  }
  refresh() {
    this.discover = true
    this.kick()
  }
  event(event) {
    if (event.type === 'router/changed' && event.payload?.id)
      this.db.call('projectFacts', { kind: 'task', id: event.payload.id }).catch(() => {
        this.error = '工作经历待重新同步'
      })
    const state = { 'thread/archived': 'archived', 'thread/unarchived': 'active', 'thread/deleted': 'deleted' }[
      event.type
    ]
    if (event.threadId && (state || event.type === 'turn/completed' || event.type === 'thread/updated')) {
      const tail = event.type === 'turn/completed'
      this.db
        .call('mark', { id: event.threadId, state, tail })
        .then((known) => {
          if (tail && known) {
            this.wakeup = true
            this.kick()
          } else this.refresh()
        })
        .catch(() => {
          this.error = '索引事件未提交'
        })
    } else if (
      ['thread/upsert', 'projects/changed'].includes(event.type) ||
      (event.type === 'connection' && event.payload.phase === 'ready')
    )
      this.refresh()
  }
  kick() {
    if (this.running || this.closed || this.paused || this.hub.status().phase !== 'ready') return
    this.wakeup = false
    this.abort = new AbortController()
    this.running = this.run(this.abort.signal)
      .catch(() => {
        if (!this.abort.signal.aborted) {
          this.phase = 'failed'
          this.error = '同步失败，可重试'
        }
      })
      .finally(() => {
        this.running = null
        if (!this.closed && !this.paused && (this.discover || this.wakeup) && this.phase !== 'failed') this.kick()
      })
  }
  async run(signal) {
    this.error = null
    if (this.discover) {
      this.discover = false
      this.phase = 'discovering'
      const seen = randomUUID()
      const known = new Map()
      const identify = async (cwd) => {
        if (!known.has(cwd)) {
          const uid = await this.projectFor(cwd)
          known.set(cwd, uid)
          if (uid) await this.db.call('observeProject', { uid, seen })
        }
        return known.get(cwd)
      }
      for (const cwd of this.registered()) {
        signal.throwIfAborted()
        await identify(cwd)
      }
      for (const archived of [false, true])
        await pages(
          (cursor) => this.hub.psmThreads({ archived, cursor }, signal),
          async (threads) => {
            for (const thread of threads) {
              signal.throwIfAborted()
              if (!thread.id || !thread.cwd || thread.ephemeral || thread.parentThreadId) continue
              let project = await identify(thread.cwd)
              if (!project) continue
              if (this.pin) {
                const bound = await this.pin(thread.id, project)
                if (!bound) continue
                if (bound !== project) {
                  project = bound
                  known.set(thread.cwd, project)
                  await this.db.call('observeProject', {uid:project,seen})
                }
              }
              await this.db.call('observe', {
                id: thread.id,
                project,
                title: thread.name ?? '',
                state: archived ? 'archived' : 'active',
                stamp: JSON.stringify([thread.updatedAt, thread.name]),
                seen,
              })
            }
          },
          signal,
        )
      signal.throwIfAborted()
      await this.db.call('finishList', seen)
      await this.db.call('retry')
      for (const kind of ['task', 'psm-entry']) {
        let after = 0
        do {
          signal.throwIfAborted()
          after = await this.db.call('projectFacts', { kind, after })
        } while (after != null)
      }
    }
    this.phase = 'indexing'
    while (!signal.aborted) {
      const row = await this.db.call('next')
      if (!row) break
      try {
        const before = await this.hub.psmMetadata(row.id, signal)
        if (before.ephemeral || before.parentThreadId || (await this.projectFor(before.cwd)) !== row.project)
          throw new Error('身份不一致')
        await this.db.call('begin')
        let foundAnchor = false
        await pages(
          (cursor) => this.hub.psmTurns(row.id, cursor, signal),
          async (turns) => {
            await this.db.call('stage', turns)
            foundAnchor = Boolean(
              row.tail && (await this.db.call('anchor', { id: row.id, ids: turns.map((turn) => turn.id) })),
            )
            return foundAnchor
          },
          signal,
        )
        const after = await this.hub.psmMetadata(row.id, signal)
        signal.throwIfAborted()
        if (after.updatedAt !== before.updatedAt || after.cwd !== before.cwd) throw new Error('读取期间来源有变化')
        await this.db.call('commit', {
          ...row,
          tail: foundAnchor ? 1 : 0,
          stamp: JSON.stringify([after.updatedAt, after.name]),
        })
      } catch (error) {
        signal.throwIfAborted()
        await this.db.call('fail', row.id)
      }
    }
    if (!signal.aborted) this.phase = 'idle'
  }
  async pause() {
    this.paused = true
    this.abort?.abort()
    await this.running
    this.phase = 'paused'
  }
  resume() {
    this.paused = false
    if (this.hub.status().phase !== 'ready') this.phase = 'waiting'
    this.refresh()
  }
  async status() {
    return { ...(await this.db.call('progress')), phase: this.phase, error: this.error ?? null }
  }
  async close() {
    this.closed = true
    clearInterval(this.timer)
    this.off()
    await this.pause()
    await this.db.close()
  }
}
