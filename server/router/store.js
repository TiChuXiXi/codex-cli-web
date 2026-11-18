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
      if (version > 1) throw new Error('Router 数据库版本高于当前程序')
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
      this.read = this.db.prepare('SELECT value FROM router_records WHERE kind=? AND id=?')
      this.save = this.db.prepare('INSERT INTO router_records (kind,id,value) VALUES (?,?,?) ON CONFLICT (kind,id) DO UPDATE SET value=excluded.value')
      this.scan = this.db.prepare('SELECT value FROM router_records WHERE kind=? ORDER BY rowid DESC LIMIT ?')
      this.append = this.db.prepare('INSERT INTO router_events (value) VALUES (?)')
      this.recent = this.db.prepare('SELECT seq,value FROM router_events ORDER BY seq DESC LIMIT ?')
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
