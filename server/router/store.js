import { DatabaseSync } from 'node:sqlite'

export class RouterStore {
  constructor(path) {
    this.db = new DatabaseSync(path)
    try {
      if (path !== ':memory:') {
        this.lock = new DatabaseSync(path + '.lock')
        // Keep a separate exclusive transaction for the lifetime of the only dispatcher.
        this.lock.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS router_instance (id INTEGER)')
      }
      const version = this.db.prepare('PRAGMA user_version').get().user_version
      if (version > 2) throw new Error('Router 数据库版本高于当前程序')
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
      if (version === 0) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS router_records (
          kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
          PRIMARY KEY (kind, id)
        );
        CREATE TABLE IF NOT EXISTS router_events (
          seq INTEGER PRIMARY KEY, value TEXT NOT NULL
        );
        PRAGMA user_version=1;
        COMMIT;
      `)
      if (version < 2) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE router_receipts (
          dispatch_id TEXT PRIMARY KEY NOT NULL,
          router_thread_id TEXT NOT NULL,
          worker_thread_id TEXT NOT NULL,
          worker_turn_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          batch_id TEXT,
          available_at INTEGER NOT NULL,
          UNIQUE (worker_thread_id, worker_turn_id)
        );
        CREATE INDEX router_receipts_pending
          ON router_receipts (router_thread_id, state, available_at, created_at);
        CREATE INDEX router_receipts_batch ON router_receipts (batch_id);
        PRAGMA user_version=2;
        COMMIT;
      `)
      this.read = this.db.prepare('SELECT value FROM router_records WHERE kind=? AND id=?')
      this.save = this.db.prepare('INSERT INTO router_records (kind,id,value) VALUES (?,?,?) ON CONFLICT (kind,id) DO UPDATE SET value=excluded.value')
      this.scan = this.db.prepare('SELECT value FROM router_records WHERE kind=? ORDER BY rowid DESC LIMIT ?')
      this.append = this.db.prepare('INSERT INTO router_events (value) VALUES (?)')
      this.recent = this.db.prepare('SELECT seq,value FROM router_events ORDER BY seq DESC LIMIT ?')
      this.insertReceipt = this.db.prepare(`
        INSERT INTO router_receipts
          (dispatch_id, router_thread_id, worker_thread_id, worker_turn_id, created_at, available_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
      `)
      this.readReceipt = this.db.prepare('SELECT state FROM router_receipts WHERE dispatch_id=?')
      this.pendingReceipts = this.db.prepare(`
        SELECT dispatch_id AS dispatchId, batch_id AS batchId FROM router_receipts
        WHERE router_thread_id=? AND state='pending' AND available_at<=?
        ORDER BY available_at, created_at, dispatch_id LIMIT ?
      `)
      this.assignReceipt = this.db.prepare("UPDATE router_receipts SET state='claimed', batch_id=? WHERE dispatch_id=? AND state='pending'")
      this.updateReceipts = this.db.prepare('UPDATE router_receipts SET state=?, available_at=? WHERE batch_id=?')
      this.inFlightWakes = this.db.prepare(`
        SELECT value FROM router_records WHERE kind='wake' AND
          json_extract(value, '$.routerThreadId')=? AND
          json_extract(value, '$.status') IN ('sending', 'accepted', 'unknown')
        ORDER BY rowid DESC
      `)
    } catch (error) {
      this.lock?.close()
      this.db.close()
      throw error
    }
  }

  get(kind, id) {
    const row = this.read.get(kind, id)
    return row ? JSON.parse(row.value) : null
  }

  put(kind, id, value) {
    this.save.run(kind, id, JSON.stringify(value))
    return value
  }

  list(kind, limit = -1) {
    return this.scan.all(kind, limit).map(row => JSON.parse(row.value))
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

  addWorkerReceipt(task) {
    return this.insertReceipt.run(task.id, task.routerThreadId, task.threadId, task.turnId, task.updatedAt, task.updatedAt).changes === 1
  }

  receiptState(dispatchId) {
    return this.readReceipt.get(dispatchId)?.state ?? null
  }

  wakeRecovery(routerThreadId) {
    return this.inFlightWakes.all(routerThreadId).map(row => JSON.parse(row.value))
  }

  event(value) {
    return { ...value, eventId: Number(this.append.run(JSON.stringify(value)).lastInsertRowid) }
  }

  events(limit) {
    return this.recent.all(limit).map(row => ({ ...JSON.parse(row.value), eventId: row.seq }))
  }

  close() {
    this.db.close()
    this.lock?.close()
  }
}
