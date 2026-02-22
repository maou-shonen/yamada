import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
  },
  table => ({
    timestampIdx: index('messages_timestamp_idx').on(table.timestamp),
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
