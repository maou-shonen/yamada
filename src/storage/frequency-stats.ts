import type { DB } from './db'
import { and, count, eq, gt } from 'drizzle-orm'
import * as schema from './schema'

/**
 * 頻率控制器 EMA 狀態
 * 每個 per-group DB 只有一筆 singleton row（id=1）
 */
export interface FrequencyState {
  emaLongBot: number
  emaLongTotal: number
  emaShortBot: number
  emaShortTotal: number
  lastUpdatedAt: number
}

/**
 * 讀取指定群組的 frequency_state row
 * 若 DB 尚未初始化過（空表），回傳 undefined
 */
export function getFrequencyState(db: DB, groupId: string): FrequencyState | undefined {
  const row = db
    .select({
      emaLongBot: schema.frequencyState.emaLongBot,
      emaLongTotal: schema.frequencyState.emaLongTotal,
      emaShortBot: schema.frequencyState.emaShortBot,
      emaShortTotal: schema.frequencyState.emaShortTotal,
      lastUpdatedAt: schema.frequencyState.lastUpdatedAt,
    })
    .from(schema.frequencyState)
    .where(eq(schema.frequencyState.groupId, groupId))
    .get()

  return row
}

/**
 * 儲存（或覆蓋）指定群組的 frequency_state row
 * 使用 INSERT OR REPLACE INTO ... (group_id) 確保每個群組只有一筆 row
 */
export function saveFrequencyState(db: DB, groupId: string, state: FrequencyState): void {
  db.insert(schema.frequencyState)
    .values({
      groupId,
      emaLongBot: state.emaLongBot,
      emaLongTotal: state.emaLongTotal,
      emaShortBot: state.emaShortBot,
      emaShortTotal: state.emaShortTotal,
      lastUpdatedAt: state.lastUpdatedAt,
    })
    .onConflictDoUpdate({
      target: schema.frequencyState.groupId,
      set: {
        emaLongBot: state.emaLongBot,
        emaLongTotal: state.emaLongTotal,
        emaShortBot: state.emaShortBot,
        emaShortTotal: state.emaShortTotal,
        lastUpdatedAt: state.lastUpdatedAt,
      },
    })
    .run()
}

/**
 * 計算指定群組在 since（Unix ms，嚴格大於）之後的訊息數
 * 回傳 total（全部訊息）和 bot（is_bot=1 的訊息）
 * 用於頻率控制器計算 bot share 統計
 */
export function countMessagesSince(
  db: DB,
  groupId: string,
  since: number,
): { total: number, bot: number } {
  const totalRow = db
    .select({ count: count() })
    .from(schema.messages)
    .where(and(eq(schema.messages.groupId, groupId), gt(schema.messages.timestamp, since)))
    .get()

  const botRow = db
    .select({ count: count() })
    .from(schema.messages)
    .where(and(eq(schema.messages.groupId, groupId), gt(schema.messages.timestamp, since), eq(schema.messages.isBot, true)))
    .get()

  return {
    total: totalRow?.count ?? 0,
    bot: botRow?.count ?? 0,
  }
}

/**
 * 計算指定群組在 since（Unix ms，嚴格大於）之後的活躍非 bot 用戶數
 * 複用 getDistinctUserIds 的查詢邏輯，但回傳 count 而非 id list
 * 用於頻率控制器計算「活躍群組大小」
 */
export function countActiveMembers(db: DB, groupId: string, since: number): number {
  const rows = db
    .selectDistinct({ userId: schema.messages.userId })
    .from(schema.messages)
    .where(and(eq(schema.messages.groupId, groupId), gt(schema.messages.timestamp, since), eq(schema.messages.isBot, false)))
    .all()

  return rows.length
}
