import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { initSchema } from '../../storage/db'
import * as schema from '../../storage/schema'

/**
 * 建立獨立的 in-memory 測試 DB（含 SQLite + Drizzle 實例）。
 * 直接使用 production 的 initSchema，避免重複維護 SQL。
 */
export function setupTestDb() {
  const sqlite = new Database(':memory:')
  initSchema(sqlite)
  const db = drizzle(sqlite, { schema })
  return { sqlite, db }
}
