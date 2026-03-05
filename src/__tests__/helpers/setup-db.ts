import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { initSchema } from '../../storage/db'
import * as schema from '../../storage/schema'

/**
 * 建立獨立的 in-memory 測試 DB（含 SQLite + Drizzle 實例）。
 * 直接使用 production 的 initSchema，避免重複維護 SQL。
 * 回傳 { db, sqlite } — 與 AppDb 形狀一致（不含 vectorStore）。
 */
export function setupTestDb() {
  const sqlite = new Database(':memory:')
  initSchema(sqlite)
  const db = drizzle(sqlite, { schema })
  return { sqlite, db }
}

/**
 * 建立帶有 groupId 前綴的測試資料 helper。
 * 方便在測試中建立不同群組的資料，無需每次手動指定 groupId。
 *
 * 用法：
 *   const { groupId } = withGroupId('group-a')
 *   await db.insert(messages).values({ groupId, ... })
 */
export function withGroupId(groupId: string) {
  return { groupId }
}
