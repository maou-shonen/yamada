import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { log } from '../logger'
import * as mainSchema from './main-schema'

export type MainDb = BunSQLiteDatabase<typeof mainSchema>

export interface MainDbConnection {
  db: MainDb
  sqlite: Database
}

const dbLog = log.withPrefix('[MainDB]')

/**
 * 開啟（或建立）全域 main.db SQLite 連線。
 *
 * - 設定 WAL mode 提升並發讀寫效能
 * - 設定 busy_timeout = 10000ms（比 per-group 的 5000ms 更高）
 * - 程式化初始化 pending_triggers table（冪等）
 *
 * @param dbPath - main.db 檔案路徑
 * @returns { db, sqlite } 物件
 */
export function openMainDb(dbPath: string): MainDbConnection {
  dbLog.withMetadata({ dbPath }).info('Opening main SQLite database')

  let sqlite: Database
  try {
    sqlite = new Database(dbPath)
  }
  catch (error) {
    throw new Error(`Failed to open main database at "${dbPath}" — check file permissions and disk space`, { cause: error })
  }

  // WAL mode 提升並發讀寫效能
  sqlite.exec('PRAGMA journal_mode = WAL')
  // 防止背景排程器與主 pipeline 發生 SQLITE_BUSY
  // 比 per-group 的 5000ms 更高，因為 main.db 是全域共享資源
  sqlite.exec('PRAGMA busy_timeout = 10000')

  // 程式化初始化 schema（不依賴 Drizzle migration 檔案）
  initMainSchema(sqlite)

  const db = drizzle(sqlite, { schema: mainSchema })
  return { db, sqlite }
}

/**
 * 程式化初始化 main.db schema。
 * 使用 CREATE TABLE IF NOT EXISTS，確保冪等性。
 */
function initMainSchema(sqlite: Database): void {
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
  try {
    sqlite.exec(`ALTER TABLE pending_triggers ADD COLUMN is_mention INTEGER NOT NULL DEFAULT 0`)
  }
  catch {
    // 已存在時略過（相容舊有 DB）
  }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_triggers_status_trigger 
    ON pending_triggers(status, trigger_at)
  `)
}

/**
 * 關閉 main.db 連線。
 *
 * - 執行 WAL checkpoint(TRUNCATE) 確保所有變更已寫入主檔案
 * - 關閉連線，確保 Docker 重啟後新容器從乾淨 DB 啟動
 *
 * @param sqlite - Database 實例
 */
export function closeMainDb(sqlite: Database): void {
  try {
    // WAL checkpoint(TRUNCATE) 確保所有變更已寫入主檔案
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }
  catch (error) {
    dbLog.withMetadata({ error }).warn('Failed to checkpoint WAL before closing')
  }

  try {
    sqlite.close()
    dbLog.info('Closed main database')
  }
  catch (error) {
    throw new Error('Failed to close main database', { cause: error })
  }
}
