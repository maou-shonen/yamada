import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * 訊息表 - 儲存此群組的所有訊息
 * Per-group DB：不需要 group_id 欄位，每個 DB 檔案本身就是隔離單位
 *
 * id: INTEGER PRIMARY KEY AUTOINCREMENT — SQLite 自動分配，是 rowid 的 alias
 * externalId: TEXT — 平台訊息 ID（Discord snowflake / LINE message ID），bot 訊息為 null
 */
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    externalId: text('external_id'),
    userId: text('user_id').notNull(),
    content: text('content').notNull(),
    isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
    timestamp: integer('timestamp').notNull(),
    replyToExternalId: text('reply_to_external_id'),
  },
  table => ({
    timestampIdx: index('messages_timestamp_idx').on(table.timestamp),
    externalIdIdx: index('messages_external_id_idx').on(table.externalId),
  }),
)

/**
 * 用戶摘要表 - 儲存此群組中每個用戶的摘要
 * Per-group DB：userId 在同一 DB 內唯一
 */
export const userSummaries = sqliteTable(
  'user_summaries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    summary: text('summary').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => ({
    userUnique: uniqueIndex('user_summaries_user_unique').on(table.userId),
  }),
)

/**
 * 群組摘要表 - 此群組的整體摘要（只有一筆記錄）
 * CAVEAT: updatedAt 同時作為 Observer 的 watermark
 * WHY: Observer.shouldRun() 使用此欄位計算「距上次壓縮以來的訊息數」
 */
export const groupSummaries = sqliteTable(
  'group_summaries',
  {
    id: text('id').primaryKey(),
    summary: text('summary').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
)

/**
 * 用戶統計表 - 儲存每個用戶每日的統計數據
 * Per-group DB：複合主鍵 (userId, date)
 * date: ISO format 'YYYY-MM-DD' in UTC
 */
export const userStats = sqliteTable(
  'user_stats',
  {
    userId: text('user_id').notNull(),
    date: text('date').notNull(),
    messageCount: integer('message_count').notNull().default(0),
    stickerCount: integer('sticker_count').notNull().default(0),
    urlCount: integer('url_count').notNull().default(0),
    mentionCount: integer('mention_count').notNull().default(0),
  },
  table => ({
    pk: primaryKey({ columns: [table.userId, table.date] }),
  }),
)

/**
 * 語義搜尋用的文字 chunk 表
 * messageIds: JSON array 字串（如 '[1,2,3]'），記錄此 chunk 涵蓋的訊息 id
 * startTimestamp / endTimestamp: chunk 涵蓋的時間範圍（Unix ms）
 */
export const chunks = sqliteTable(
  'chunks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    content: text('content').notNull(),
    messageIds: text('message_ids').notNull(), // JSON array as TEXT
    startTimestamp: integer('start_timestamp').notNull(),
    endTimestamp: integer('end_timestamp').notNull(),
  },
  table => ({
    endTimestampIdx: index('chunks_end_timestamp_idx').on(table.endTimestamp),
  }),
)

/**
 * 頻率控制器 EMA 狀態表（Singleton）
 * 每個 per-group DB 只有一筆 row（id=1），使用 INSERT OR REPLACE 更新
 * 儲存長短期 EMA 數值，供頻率控制器在重啟後恢復狀態
 */
export const frequencyState = sqliteTable('frequency_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  emaLongBot: real('ema_long_bot').notNull().default(0),
  emaLongTotal: real('ema_long_total').notNull().default(0),
  emaShortBot: real('ema_short_bot').notNull().default(0),
  emaShortTotal: real('ema_short_total').notNull().default(0),
  lastUpdatedAt: integer('last_updated_at').notNull().default(0),
})
