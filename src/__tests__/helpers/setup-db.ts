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
      timestamp INTEGER NOT NULL,
      reply_to_external_id TEXT
    )
  `)
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages(timestamp)
  `)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS messages_external_id_idx ON messages(external_id)`)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      message_ids TEXT NOT NULL,
      start_timestamp INTEGER NOT NULL,
      end_timestamp INTEGER NOT NULL
    )
  `)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS chunks_end_timestamp_idx ON chunks(end_timestamp)`)
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
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      sticker_count INTEGER NOT NULL DEFAULT 0,
      url_count INTEGER NOT NULL DEFAULT 0,
      mention_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    )
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS frequency_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ema_long_bot REAL NOT NULL DEFAULT 0,
      ema_long_total REAL NOT NULL DEFAULT 0,
      ema_short_bot REAL NOT NULL DEFAULT 0,
      ema_short_total REAL NOT NULL DEFAULT 0,
      last_updated_at INTEGER NOT NULL DEFAULT 0
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
