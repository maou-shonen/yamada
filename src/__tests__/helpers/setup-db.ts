import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from '../../storage/schema'

/**
 * 在 SQLite 實例上建立所有表（用於測試，不經過 migration）
 */
export function setupTables(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      is_bot INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL
    )
  `)
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages(timestamp)
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_summaries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id)
    )
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS group_summaries (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
}

/**
 * 建立獨立的 in-memory 測試 DB（含 SQLite + Drizzle 實例）
 */
export function setupTestDb() {
  const sqlite = new Database(':memory:')
  setupTables(sqlite)
  const db = drizzle(sqlite, { schema })
  return { sqlite, db }
}
