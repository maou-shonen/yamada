import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 全域 pending_triggers 表 — 儲存各群組的排程觸發狀態
 *
 * 每個群組最多一筆記錄（group_id 為 PRIMARY KEY）
 * 用於 debounce 排程器判斷何時觸發 AI 回覆
 */
export const pendingTriggers = sqliteTable(
  'pending_triggers',
  {
    /** 群組 ID（PRIMARY KEY，每個群組最多一筆） */
    groupId: text('group_id').primaryKey(),
    /** 平台識別：'discord' | 'line' */
    platform: text('platform').notNull(),
    /** 排程觸發時間（epoch ms），排程器查詢此欄位決定何時觸發 */
    triggerAt: integer('trigger_at').notNull(),
    /** 累積字元數（用於溢出觸發檢測），預設 0 */
    pendingChars: integer('pending_chars').notNull().default(0),
    /** 狀態：'pending' | 'processing'，預設 'pending' */
    status: text('status').notNull().default('pending'),
    /** 建立時間（epoch ms） */
    createdAt: integer('created_at').notNull(),
    /** 最後更新時間（epoch ms） */
    updatedAt: integer('updated_at').notNull(),
  },
  table => ({
    /** 複合索引：排程器常查詢 (status, trigger_at) 組合 */
    statusTriggerIdx: index('idx_triggers_status_trigger').on(table.status, table.triggerAt),
  }),
)
