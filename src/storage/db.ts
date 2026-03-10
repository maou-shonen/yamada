import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { log } from '../logger'
import * as schema from './schema'
import { SqliteVectorStore } from './sqlite-vector-store'

export type DB = BunSQLiteDatabase<typeof schema>

export interface AppDb {
  db: DB
  sqlite: Database
}

const dbLog = log.withPrefix('[DB]')

/**
 * 開啟（或建立）SQLite DB 並初始化 schema + sqlite-vec 擴充。
 *
 * - 自動建立父目錄（若不存在）
 * - 設定 WAL mode + busy_timeout = 10000ms
 * - 程式化建立 schema（CREATE TABLE IF NOT EXISTS）
 * - 載入 sqlite-vec 擴充（需傳入 dimensions）
 *
 * @param dbPath - DB 檔案路徑
 * @param dimensions - 向量維度（供 sqlite-vec 初始化）
 * @returns 包含 Drizzle ORM 實例（db）與原生 SQLite 連線（sqlite）的 AppDb 物件
 */
export function openDb(dbPath: string, dimensions: number): AppDb {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    dbLog.withMetadata({ dir }).info('Created database directory')
  }

  dbLog.withMetadata({ dbPath }).info('Opening SQLite database')

  let sqlite: Database
  try {
    sqlite = new Database(dbPath)
  }
  catch (error) {
    throw new Error(`Failed to open database at "${dbPath}" — check file permissions and disk space`, { cause: error })
  }

  // WAL mode 提升並發讀寫效能
  sqlite.exec('PRAGMA journal_mode = WAL')
  // 統一使用 10000ms busy_timeout（原 main.db 使用此值）
  sqlite.exec('PRAGMA busy_timeout = 10000')

  // 程式化建立 schema（不依賴 Drizzle migration 檔案）
  initSchema(sqlite)

  const db = drizzle(sqlite, { schema })

  // 載入 sqlite-vec 擴充（註冊於此連線上，VectorStore 實例可之後獨立建立）
  const vectorStore = new SqliteVectorStore(sqlite)
  vectorStore.init(dimensions)

  return { db, sqlite }
}

/**
 * 關閉 DB 連線。
 *
 * 注意：不執行 WAL checkpoint — 由 Litestream 接管 WAL 管理。
 */
export function closeDb(appDb: AppDb): void {
  try {
    appDb.sqlite.close()
    dbLog.info('Closed database')
  }
  catch (error) {
    throw new Error('Failed to close database', { cause: error })
  }
}

/**
 * 程式化初始化 schema。
 * 使用 CREATE TABLE IF NOT EXISTS，確保冪等性。
 */
export function initSchema(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      external_id TEXT,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      is_bot INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      reply_to_external_id TEXT
    )
  `)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages(group_id, timestamp)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS messages_external_id_idx ON messages(group_id, external_id)`)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_summaries (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS user_summaries_user_unique ON user_summaries(group_id, user_id)`)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS group_summaries (
      group_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_stats (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      sticker_count INTEGER NOT NULL DEFAULT 0,
      url_count INTEGER NOT NULL DEFAULT 0,
      mention_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, user_id, date)
    )
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      content TEXT NOT NULL,
      message_ids TEXT NOT NULL,
      start_timestamp INTEGER NOT NULL,
      end_timestamp INTEGER NOT NULL
    )
  `)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS chunks_end_timestamp_idx ON chunks(group_id, end_timestamp)`)
  // 移除舊的 message_vectors 虛擬表（已由 chunk_vectors 取代）
  // DROP TABLE IF EXISTS 對虛擬表同樣有效
  try {
    sqlite.exec(`DROP TABLE IF EXISTS message_vectors`)
  }
  catch {
    // 若表不存在或已刪除，略過
  }
  // 移除舊的 sqlite-vec 虛擬表（已由 SqliteVectorStore 管理）
  try {
    sqlite.exec(`DROP TABLE IF EXISTS chunk_vectors`)
  }
  catch {
    // 若表不存在或已刪除，略過
  }
  try {
    sqlite.exec(`DROP TABLE IF EXISTS fact_vectors`)
  }
  catch {
    // 若表不存在或已刪除，略過
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS frequency_state (
      group_id TEXT PRIMARY KEY,
      ema_long_bot REAL NOT NULL DEFAULT 0,
      ema_long_total REAL NOT NULL DEFAULT 0,
      ema_short_bot REAL NOT NULL DEFAULT 0,
      ema_short_total REAL NOT NULL DEFAULT 0,
      last_updated_at INTEGER NOT NULL DEFAULT 0
    )
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_aliases (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      user_name TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, alias)
    )
  `)
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS user_aliases_alias_unique ON user_aliases(group_id, alias)`)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      user_id TEXT,
      canonical_key TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS facts_canonical_key_unique ON facts(group_id, canonical_key, scope, COALESCE(user_id, '')) WHERE status = 'active'`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS facts_scope_user_status_idx ON facts(group_id, scope, user_id, status)`)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      description TEXT,
      mime_type TEXT NOT NULL DEFAULT 'image/webp',
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      thumbnail BLOB NOT NULL
    )
  `)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS images_message_idx ON images(group_id, message_id)`)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS fact_metadata (
      group_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (group_id, key)
    )
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pending_triggers (
      group_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      trigger_at INTEGER NOT NULL,
      pending_chars INTEGER NOT NULL DEFAULT 0,
      is_mention INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_triggers_status_trigger ON pending_triggers(status, trigger_at)`)
}
