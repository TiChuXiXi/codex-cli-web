import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'

export function redact(value) {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, '[redacted]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, '[redacted]')
    .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(
      /((?:token|api[_-]?key|password|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
}

export function searchTerms(value) {
  const words =
    value
      .normalize('NFKC')
      .toLowerCase()
      .match(/\p{Script=Han}+|[\p{L}\p{N}_]+/gu) ?? []
  const result = []
  for (const word of words) {
    // Split mixed scripts even when a Latin identifier precedes Chinese text.
    for (const part of word.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_])+/gu)) {
      const chars = Array.from(part)
      if (/^\p{Script=Han}/u.test(part) && chars.length > 1) {
        for (let i = 1; i < chars.length; i++) result.push(chars[i - 1] + chars[i])
      } else result.push(part)
    }
  }
  return [...new Set(result)].join(' ')
}

export function visibleText(item) {
  if (item.type === 'agentMessage') return typeof item.text === 'string' ? redact(item.text) : ''
  if (item.type !== 'userMessage') return ''
  return redact(
    (item.content ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n'),
  )
}

export class SourceIndex {
  constructor(path, routerPath) {
    if (routerPath) this.router = new DatabaseSync(routerPath, { readOnly: true })
    this.db = new DatabaseSync(path)
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (version > 1) {
      this.close()
      throw new Error('索引版本高于当前程序')
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS projects(uid TEXT PRIMARY KEY,seen TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads(
        id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
        stamp TEXT NOT NULL, seen TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 1,
        failed INTEGER NOT NULL DEFAULT 0, synced INTEGER, tail INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS turns(thread TEXT, id TEXT, stamp INTEGER, status TEXT, PRIMARY KEY(thread,id));
      CREATE TABLE IF NOT EXISTS fragments(thread TEXT, turn TEXT, item TEXT, part INTEGER,
        role TEXT, body TEXT, terms TEXT, hash TEXT, UNIQUE(thread,turn,item,part));
      CREATE VIRTUAL TABLE IF NOT EXISTS ft USING fts5(terms,content='fragments',content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS fi AFTER INSERT ON fragments BEGIN
        INSERT INTO ft(rowid,terms) VALUES(new.rowid,new.terms); END;
      CREATE TRIGGER IF NOT EXISTS fd AFTER DELETE ON fragments BEGIN
        INSERT INTO ft(ft,rowid,terms) VALUES('delete',old.rowid,old.terms); END;
      CREATE TRIGGER IF NOT EXISTS fu AFTER UPDATE ON fragments BEGIN
        INSERT INTO ft(ft,rowid,terms) VALUES('delete',old.rowid,old.terms);
        INSERT INTO ft(rowid,terms) VALUES(new.rowid,new.terms); END;
      CREATE TABLE IF NOT EXISTS fact_docs(id TEXT PRIMARY KEY,kind TEXT,project TEXT,at INTEGER,terms TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS fact_ft USING fts5(terms,content='fact_docs',content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS fact_insert AFTER INSERT ON fact_docs BEGIN
        INSERT INTO fact_ft(rowid,terms) VALUES(new.rowid,new.terms); END;
      CREATE TRIGGER IF NOT EXISTS fact_delete AFTER DELETE ON fact_docs BEGIN
        INSERT INTO fact_ft(fact_ft,rowid,terms) VALUES('delete',old.rowid,old.terms); END;
      CREATE TRIGGER IF NOT EXISTS fact_update AFTER UPDATE OF terms ON fact_docs BEGIN
        INSERT INTO fact_ft(fact_ft,rowid,terms) VALUES('delete',old.rowid,old.terms);
        INSERT INTO fact_ft(rowid,terms) VALUES(new.rowid,new.terms); END;
      INSERT INTO ft(ft,rank) VALUES('secure-delete',1);
      INSERT INTO fact_ft(fact_ft,rank) VALUES('secure-delete',1);
      CREATE TEMP TABLE staged_turns(id TEXT PRIMARY KEY, stamp INTEGER, status TEXT);
      CREATE TEMP TABLE staged(turn TEXT,item TEXT,part INTEGER,role TEXT,body TEXT,terms TEXT,hash TEXT,
        PRIMARY KEY(turn,item,part));
    `)
    if (version === 0) this.transaction(() => {
      if (!this.db.prepare("PRAGMA table_info(threads)").all().some(column => column.name === "tail"))
        this.db.exec("ALTER TABLE threads ADD COLUMN tail INTEGER DEFAULT 0")
      this.db.exec("PRAGMA user_version=1")
    })
  }
  verify() {
    this.db.exec("INSERT INTO ft(ft,rank) VALUES('integrity-check',1); INSERT INTO fact_ft(fact_ft,rank) VALUES('integrity-check',1)")
  }
  anchor({ id, ids }) {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM turns WHERE thread=? AND id IN (SELECT value FROM json_each(?)) AND status IN ('completed','failed','interrupted') LIMIT 1",
        )
        .get(id, JSON.stringify(ids)) != null
    )
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  observeProject({ uid, seen }) {
    this.db
      .prepare(
        "INSERT INTO projects VALUES(?,?,'active') ON CONFLICT(uid) DO UPDATE SET seen=excluded.seen,state='active'",
      )
      .run(uid, seen)
  }
  observe({ id, project, title, state, stamp, seen }) {
    this.db
      .prepare(
        `INSERT INTO threads(id,project,title,state,stamp,seen) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,state=excluded.state,stamp=excluded.stamp,seen=excluded.seen,
      tail=CASE WHEN threads.stamp<>excluded.stamp OR threads.state<>excluded.state THEN 0 ELSE threads.tail END,
      dirty=CASE WHEN threads.stamp<>excluded.stamp OR threads.state<>excluded.state THEN threads.dirty+1 ELSE threads.dirty END
      WHERE threads.project=excluded.project AND threads.state<>'deleted'`,
      )
      .run(id, project, redact(title), state, stamp, seen)
  }
  finishList(seen) {
    this.db.prepare("UPDATE projects SET state='missing' WHERE seen<>?").run(seen)
    this.db
      .prepare("UPDATE threads SET state='missing' WHERE seen<>? AND state IN ('active','archived')")
      .run(seen)
    // Revisit old content even when the provider's metadata watermark stays unchanged.
    this.db.exec(
      "UPDATE threads SET dirty=1 WHERE id IN (SELECT id FROM threads WHERE dirty=0 AND state='active' ORDER BY synced LIMIT 1)",
    )
  }
  mark({ id, state, tail = false }) {
    if (state === 'deleted')
      return this.transaction(() => {
        this.db.prepare("UPDATE threads SET state='deleted',dirty=0 WHERE id=?").run(id)
        for (const table of ['turns', 'fragments'])
          this.db.prepare('DELETE FROM ' + table + ' WHERE thread=?').run(id)
      })
    return this.db
      .prepare(
        `UPDATE threads SET dirty=dirty+1,tail=CASE WHEN ? AND synced IS NOT NULL AND (dirty=0 OR tail=1) THEN 1 ELSE 0 END,
      state=coalesce(?,state) WHERE id=? AND state<>'deleted'`,
      )
      .run(tail ? 1 : 0, state ?? null, id).changes
  }
  retry() {
    this.db.exec('UPDATE threads SET failed=0')
  }
  fail(id) {
    this.db.prepare('UPDATE threads SET failed=1 WHERE id=?').run(id)
  }
  next() {
    return this.db
      .prepare(
        "SELECT * FROM threads WHERE state IN ('active','archived') AND dirty>0 AND failed=0 ORDER BY synced,id LIMIT 1",
      )
      .get()
  }
  begin() {
    this.db.exec('DELETE FROM staged_turns; DELETE FROM staged;')
  }
  stage(turns) {
    const turnRow = this.db.prepare('INSERT OR REPLACE INTO staged_turns VALUES(?,?,?)')
    const fragment = this.db.prepare('INSERT OR REPLACE INTO staged VALUES(?,?,?,?,?,?,?)')
    this.transaction(() => {
      for (const turn of turns) {
        if (!turn.id || !Array.isArray(turn.items) || ['summary', 'notLoaded'].includes(turn.itemsView))
          throw new Error('Incomplete turn')
        turnRow.run(turn.id, turn.startedAt ?? null, turn.status ?? null)
        for (const item of turn.items) {
          const value = visibleText(item)
          if (!value) continue
          if (!item.id) throw new Error('Missing item identity')
          const chars = Array.from(value)
          for (let start = 0, part = 0; start < chars.length; start += 2016, part++) {
            const body = chars.slice(start, start + 2048).join('')
            fragment.run(
              turn.id,
              item.id,
              part,
              item.type,
              body,
              searchTerms(body),
              createHash('sha256').update(body).digest('hex'),
            )
            if (start + 2048 >= chars.length) break
          }
        }
      }
    })
  }
  commit({ id, dirty, tail = 0, stamp }) {
    return this.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE threads SET synced=?,dirty=0,tail=0,failed=0,stamp=coalesce(?,stamp) WHERE id=? AND dirty=? AND state IN ('active','archived')",
        )
        .run(Date.now(), stamp ?? null, id, dirty)
      if (!changed.changes) return false
      if (!tail)
        this.db.prepare('DELETE FROM turns WHERE thread=? AND id NOT IN (SELECT id FROM staged_turns)').run(id)
      this.db.prepare('INSERT OR REPLACE INTO turns SELECT ?,id,stamp,status FROM staged_turns').run(id)
      this.db
        .prepare(
          `DELETE FROM fragments WHERE thread=? AND (?=0 OR turn IN (SELECT id FROM staged_turns)) AND NOT EXISTS
        (SELECT 1 FROM staged s WHERE s.turn=fragments.turn AND s.item=fragments.item AND s.part=fragments.part)`,
        )
        .run(id, tail)
      this.db
        .prepare(
          `INSERT INTO fragments SELECT ?,turn,item,part,role,body,terms,hash FROM staged WHERE true
        ON CONFLICT(thread,turn,item,part) DO UPDATE SET role=excluded.role,body=excluded.body,terms=excluded.terms,hash=excluded.hash
        WHERE fragments.hash<>excluded.hash OR fragments.role<>excluded.role`,
        )
        .run(id)
      return true
    })
  }
  progress() {
    return this.db
      .prepare(
        `SELECT count(*) total,(SELECT count(*) FROM projects WHERE state='active') projects,
      count(*) FILTER(WHERE synced IS NOT NULL) AS "indexed",count(*) FILTER(WHERE dirty>0 AND state IN ('active','archived')) pending,
      count(*) FILTER(WHERE failed=1) failed,max(synced) lastSynced FROM threads`,
      )
      .get()
  }
  search({ query, projects, limit = 12 }) {
    const tokens = searchTerms(query).split(' ').filter(Boolean).slice(0, 24)
    if (!tokens.length || !projects.length) return []
    return this.db
      .prepare(
        `WITH matches AS MATERIALIZED (
      SELECT t.project,t.title,t.state,f.thread,f.turn,f.item,f.part,f.role,f.body,f.hash,u.stamp,ft.rank AS score
      FROM ft JOIN fragments f ON f.rowid=ft.rowid JOIN threads t ON t.id=f.thread JOIN turns u ON u.thread=f.thread AND u.id=f.turn
      WHERE ft MATCH ? AND t.project IN (SELECT value FROM json_each(?)) AND t.state IN ('active','archived'))
      SELECT *,row_number() OVER(PARTITION BY thread ORDER BY score,stamp DESC) AS position FROM matches
      ORDER BY position,score,stamp DESC LIMIT ?`,
      )
      .all(tokens.map((t) => '"' + t + '"').join(' AND '), JSON.stringify(projects), limit)
  }
  projectFacts({ kind, id, after = 0 }) {
    if (!this.router) return null
    const rows = id
      ? this.router.prepare('SELECT rowid,value FROM router_records WHERE kind=? AND id=?').all(kind, id)
      : this.router
          .prepare('SELECT rowid,value FROM router_records WHERE kind=? AND rowid>? ORDER BY rowid LIMIT 32')
          .all(kind, after)
    const get = (kind, id) =>
      JSON.parse(
        this.router.prepare('SELECT value FROM router_records WHERE kind=? AND id=?').get(kind, id)?.value ??
          'null',
      )
    this.transaction(() => {
      for (const record of rows) {
        const row = JSON.parse(record.value)
        const semantic = kind === 'psm-entry',
          uid = semantic ? row.uid : (row.psmProjectUid ?? (row.threadId && get('psm-thread', row.threadId)?.uid))
        const ref = (semantic ? 'entry:' : 'task:') + row.id
        if (
          !uid ||
          (semantic && row.state !== 'active') ||
          !this.router
            .prepare("SELECT 1 FROM router_records WHERE kind='psm-project' AND json_extract(value,'$.uid')=?")
            .get(uid)
        ) {
          this.db.prepare('DELETE FROM fact_docs WHERE id=?').run(ref)
          continue
        }
        const text = semantic
          ? row.value
          : [row.instruction, row.summary, get('message', 'worker-result:' + row.id)?.text]
              .filter(Boolean)
              .join(' ')
        this.db
          .prepare(
            `INSERT INTO fact_docs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind,project=excluded.project,at=excluded.at,terms=excluded.terms
          WHERE fact_docs.kind<>excluded.kind OR fact_docs.project<>excluded.project OR fact_docs.at<>excluded.at OR fact_docs.terms<>excluded.terms`,
          )
          .run(ref, semantic ? row.level : 'router_observed', uid, row.updatedAt ?? 0, searchTerms(redact(text)))
      }
    })
    return !id && rows.length === 32 ? rows.at(-1).rowid : null
  }
  factHits({ query, projects, limit }) {
    const words = searchTerms(query).split(' ').filter(Boolean).slice(0, 24)
    if (!words.length || !projects.length) return []
    const allowed = JSON.stringify(projects)
    const hits = this.db
      .prepare(
        `SELECT id,kind FROM fact_ft JOIN fact_docs d ON d.rowid=fact_ft.rowid WHERE fact_ft MATCH ?
      AND project IN (SELECT value FROM json_each(?)) ORDER BY CASE kind WHEN 'user_confirmed' THEN 0 WHEN 'router_observed' THEN 1 ELSE 2 END,rank,at DESC LIMIT ?`,
      )
      .all(words.map((w) => '"' + w + '"').join(' AND '), allowed, limit)
    if (/上次|刚才|最近/.test(query)) {
      const recent = this.db
        .prepare(
          `SELECT id,kind FROM fact_docs WHERE kind='router_observed' AND project IN
        (SELECT value FROM json_each(?)) ORDER BY at DESC LIMIT ?`,
        )
        .all(allowed, limit)
      for (const row of recent) if (!hits.some((h) => h.id === row.id)) hits.push(row)
    }
    return hits
  }
  recentTopics(project) {
    return this.db.prepare(`SELECT id,title FROM threads WHERE project=? AND state IN ('active','archived')
      AND synced IS NOT NULL AND dirty=0 AND title<>'' ORDER BY synced DESC,id LIMIT 3`).all(project)
  }
  source(id) {
    return this.db.prepare('SELECT id,project,state,title FROM threads WHERE id=?').get(id)
  }
  purge(project) {
    this.transaction(() => {
      for (const table of ['fragments', 'turns'])
        this.db
          .prepare('DELETE FROM ' + table + ' WHERE thread IN (SELECT id FROM threads WHERE project=?)')
          .run(project)
      this.db.prepare('DELETE FROM threads WHERE project=?').run(project)
      this.db.prepare('DELETE FROM fact_docs WHERE project=?').run(project)
      this.db.prepare('DELETE FROM projects WHERE uid=?').run(project)
    })
    this.db.exec("INSERT INTO ft(ft) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE)")
  }
  close() {
    this.router?.close()
    this.db.close()
  }
}

if (parentPort && workerData?.psmPath) {
  const store = new SourceIndex(workerData.psmPath, workerData.routerPath)
  parentPort.on('message', ({ id, method, args }) => {
    try {
      parentPort.postMessage({ id, result: store[method](args) })
    } catch {
      parentPort.postMessage({ id, error: 'PSM 索引操作失败：' + method })
    }
  })
}
