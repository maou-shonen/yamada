import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { log } from '../logger'
import * as schema from './schema'

export type DB = BunSQLiteDatabase<typeof schema>

export interface GroupDb {
  db: DB
  sqlite: Database
}

const dbLog = log.withPrefix('[DB]')

/**
 * 開啟（或建立）指定群組的 SQLite DB。
 * 每次呼叫都回傳新的連線，由 GroupDbManager 負責快取。
 */
const SAFE_GROUP_ID_REGEX = /^[\w-]+$/

export function openGroupDb(dbDir: string, groupId: string): GroupDb {
  if (!SAFE_GROUP_ID_REGEX.test(groupId)) {
    throw new Error(`Invalid groupId "${groupId}" — must contain only alphanumeric characters, underscores, and hyphens`)
  }

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
    dbLog.withMetadata({ dbDir }).info('Created database directory')
  }

  const dbPath = join(dbDir, `${groupId}.db`)
  dbLog.withMetadata({ dbPath }).info('Opening group SQLite database')

  let sqlite: Database
  try {
    sqlite = new Database(dbPath)
  }
  catch (error) {
    throw new Error(`Failed to open database at "${dbPath}" — check file permissions and disk space`, { cause: error })
  }

  // WAL mode 提升並發讀寫效能
  sqlite.exec('PRAGMA journal_mode = WAL')
  // 防止 Observer/Embedding 背景任務與主 pipeline 發生 SQLITE_BUSY
  sqlite.exec('PRAGMA busy_timeout = 5000')

  // 程式化建立 schema（不依賴 Drizzle migration 檔案）
  initSchema(sqlite)

  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

/**
 * 程式化初始化 schema。
 * 使用 CREATE TABLE IF NOT EXISTS，確保冪等性。
 */
function initSchema(sqlite: Database): void {
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
 * 管理多個群組 DB 連線的快取。
 * 每個 groupId 對應一個 GroupDb 實例，lazy init。
 */
export class GroupDbManager {
  private readonly cache = new Map<string, GroupDb>()
  private readonly dbDir: string

  constructor(dbDir: string) {
    this.dbDir = dbDir
  }

  /**
   * 取得或建立指定群組的 DB 連線。
   * 若已存在則直接回傳快取，否則呼叫 openGroupDb 建立新連線。
   */
  getOrCreate(groupId: string): GroupDb {
    const existing = this.cache.get(groupId)
    if (existing) {
      return existing
    }

    const groupDb = openGroupDb(this.dbDir, groupId)
    this.cache.set(groupId, groupDb)
    dbLog.withMetadata({ groupId }).info('Created new group DB')
    return groupDb
  }

  /** Graceful shutdown：關閉所有已開啟的 DB 連線 */
  closeAll(): void {
    for (const [groupId, { sqlite }] of this.cache) {
      sqlite.close()
      dbLog.withMetadata({ groupId }).info('Closed group DB')
    }
    this.cache.clear()
  }
}
