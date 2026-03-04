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

/**
 * 用戶別名表 - 儲存此群組中每個用戶的隱私別名
 * Per-group DB：複合主鍵 (userId, alias)，alias 全域唯一
 * userName: 原始用戶名稱（用於 bot 訊息儲存時的內容替換）
 * updatedAt: 別名建立或更新時間戳（Unix ms）
 */
export const userAliases = sqliteTable(
  'user_aliases',
  {
    userId: text('user_id').notNull(),
    alias: text('alias').notNull(),
    userName: text('user_name').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.userId, table.alias] }),
    aliasUnique: uniqueIndex('user_aliases_alias_unique').on(table.alias),
  }),
)

/**
 * Facts 表 - 儲存從對話中萃取的結構化知識
 * scope: 'user'（個人事實）或 'group'（群組事實）
 * userId: 個人事實的擁有者，群組事實為 null
 * canonicalKey: 正規化鍵（用於判斷重複/更新）
 * status: 'active' | 'superseded' | 'contradicted'
 */
export const facts = sqliteTable(
  'facts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope').notNull(),
    userId: text('user_id'),
    canonicalKey: text('canonical_key').notNull(),
    content: text('content').notNull(),
    confidence: real('confidence').notNull().default(1.0),
    evidenceCount: integer('evidence_count').notNull().default(1),
    status: text('status').notNull().default('active'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => ({
    scopeUserStatusIdx: index('facts_scope_user_status_idx').on(table.scope, table.userId, table.status),
    canonicalKeyUnique: uniqueIndex('facts_canonical_key_unique').on(table.canonicalKey, table.scope, table.userId),
  }),
)

/**
 * Fact Metadata 表 - 儲存 fact 相關的元資料（如 watermark）
 * Singleton key-value store
 */
export const factMetadata = sqliteTable('fact_metadata', {
  key: text('key').primaryKey(),
  value: integer('value').notNull(),
})
