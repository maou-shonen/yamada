// @deprecated — use openDb() / closeDb() from ./db instead.
// This file is kept for backward compatibility during migration.
// T16 will clean up all remaining imports.

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
 * @deprecated Use `openDb()` from `./db` instead.
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

  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA busy_timeout = 10000')

  initMainSchema(sqlite)

  const db = drizzle(sqlite, { schema: mainSchema })
  return { db, sqlite }
}

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
 * @deprecated Use `closeDb()` from `./db` instead.
 * Note: This function still performs WAL checkpoint for backward compatibility.
 * The new `closeDb()` does NOT checkpoint (Litestream compatibility).
 */
export function closeMainDb(sqlite: Database): void {
  try {
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
