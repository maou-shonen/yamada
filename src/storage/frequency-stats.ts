import type { DB } from './db'
import { and, count, eq, gt, sql } from 'drizzle-orm'
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
 * 讀取 frequency_state singleton row（id=1）
 * 若 DB 尚未初始化過（空表），回傳 undefined
 */
export function getFrequencyState(db: DB): FrequencyState | undefined {
  const row = db
    .select({
      emaLongBot: schema.frequencyState.emaLongBot,
      emaLongTotal: schema.frequencyState.emaLongTotal,
      emaShortBot: schema.frequencyState.emaShortBot,
      emaShortTotal: schema.frequencyState.emaShortTotal,
      lastUpdatedAt: schema.frequencyState.lastUpdatedAt,
    })
    .from(schema.frequencyState)
    .where(eq(schema.frequencyState.id, 1))
    .get()

  return row
}

/**
 * 儲存（或覆蓋）frequency_state singleton row
 * 使用 INSERT OR REPLACE INTO ... (id=1) 確保永遠只有一筆 row
 */
export function saveFrequencyState(db: DB, state: FrequencyState): void {
  db.run(
    sql`INSERT OR REPLACE INTO frequency_state
        (id, ema_long_bot, ema_long_total, ema_short_bot, ema_short_total, last_updated_at)
        VALUES (1, ${state.emaLongBot}, ${state.emaLongTotal}, ${state.emaShortBot}, ${state.emaShortTotal}, ${state.lastUpdatedAt})`,
  )
}

/**
 * 計算 since（Unix ms，嚴格大於）之後的訊息數
 * 回傳 total（全部訊息）和 bot（is_bot=1 的訊息）
 * 用於頻率控制器計算 bot share 統計
 */
export function countMessagesSince(
  db: DB,
  since: number,
): { total: number; bot: number } {
  const totalRow = db
    .select({ count: count() })
    .from(schema.messages)
    .where(gt(schema.messages.timestamp, since))
    .get()

  const botRow = db
    .select({ count: count() })
    .from(schema.messages)
    .where(and(gt(schema.messages.timestamp, since), eq(schema.messages.isBot, true)))
    .get()

  return {
    total: totalRow?.count ?? 0,
    bot: botRow?.count ?? 0,
  }
}

/**
 * 計算 since（Unix ms，嚴格大於）之後的活躍非 bot 用戶數
 * 複用 getDistinctUserIds 的查詢邏輯，但回傳 count 而非 id list
 * 用於頻率控制器計算「活躍群組大小」
 */
export function countActiveMembers(db: DB, since: number): number {
  const rows = db
    .selectDistinct({ userId: schema.messages.userId })
    .from(schema.messages)
    .where(and(gt(schema.messages.timestamp, since), eq(schema.messages.isBot, false)))
    .all()

  return rows.length
}
