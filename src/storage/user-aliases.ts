import type { DB } from './db'
import { and, eq, inArray } from 'drizzle-orm'
import { generateAlias } from '../utils/alias-generator'
import * as schema from './schema'

/**
 * 取得指定群組中所有已存在的 alias 集合，供碰撞檢測使用。
 * 同步函式——直接讀取 per-group DB。
 */
export function getAllAliases(db: DB, groupId: string): Set<string> {
  const rows = db
    .select({ alias: schema.userAliases.alias })
    .from(schema.userAliases)
    .where(eq(schema.userAliases.groupId, groupId))
    .all()

  return new Set(rows.map(row => row.alias))
}

/**
 * 查詢或建立用戶 alias。
 *
 * - userId === 'bot'：直接回傳 `{ alias: 'bot', userName }`，不寫入 DB
 * - userId 已有 alias（在此群組）：更新 userName 和 updatedAt，回傳現有 alias
 * - userId 不存在（在此群組）：產生唯一 alias，INSERT，回傳
 */
export async function getOrCreateAlias(
  db: DB,
  groupId: string,
  userId: string,
  userName: string,
): Promise<{ alias: string, userName: string }> {
  // Bot 特例：不進 DB
  if (userId === 'bot') {
    return { alias: 'bot', userName }
  }

  // 取得現有 alias 集合（用於碰撞檢測，限於此群組）
  const existingAliases = getAllAliases(db, groupId)

  // 查詢此 userId 是否已有 alias（在此群組）
  const existing = db
    .select()
    .from(schema.userAliases)
    .where(
      and(
        eq(schema.userAliases.groupId, groupId),
        eq(schema.userAliases.userId, userId),
      ),
    )
    .get()

  if (existing) {
    // 已存在：更新 userName 和 updatedAt
    db.update(schema.userAliases)
      .set({ userName, updatedAt: Date.now() })
      .where(
        and(
          eq(schema.userAliases.groupId, groupId),
          eq(schema.userAliases.userId, userId),
          eq(schema.userAliases.alias, existing.alias),
        ),
      )
      .run()

    return { alias: existing.alias, userName }
  }

  // 不存在：產生唯一 alias 並 INSERT
  const alias = generateAlias(existingAliases)

  db.insert(schema.userAliases)
    .values({ groupId, userId, alias, userName, updatedAt: Date.now() })
    .run()

  return { alias, userName }
}

/**
 * 批量查詢指定群組中多個 userId 的 alias 和 userName。
 * 回傳 `Map<userId, { alias, userName }>`；不在 DB 的 userId 不包含在 Map 中。
 */
export async function getAliasMap(
  db: DB,
  groupId: string,
  userIds: string[],
): Promise<Map<string, { alias: string, userName: string }>> {
  if (userIds.length === 0) {
    return new Map()
  }

  const rows = db
    .select()
    .from(schema.userAliases)
    .where(
      and(
        eq(schema.userAliases.groupId, groupId),
        inArray(schema.userAliases.userId, userIds),
      ),
    )
    .all()

  return new Map(
    rows.map(row => [row.userId, { alias: row.alias, userName: row.userName }]),
  )
}
