import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * 訊息表 - 儲存所有群組的訊息
 *
 * id: INTEGER PRIMARY KEY AUTOINCREMENT — SQLite 自動分配，是 rowid 的 alias
 * externalId: TEXT — 平台訊息 ID（Discord snowflake / LINE message ID），bot 訊息為 null
 */
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: text('group_id').notNull(),
    externalId: text('external_id'),
    userId: text('user_id').notNull(),
    content: text('content').notNull(),
    isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
    timestamp: integer('timestamp').notNull(),
    replyToExternalId: text('reply_to_external_id'),
  },
  table => ({
    timestampIdx: index('messages_timestamp_idx').on(table.groupId, table.timestamp),
    externalIdIdx: index('messages_external_id_idx').on(table.groupId, table.externalId),
  }),
)

/**
 * 用戶摘要表 - 儲存每個群組中每個用戶的摘要
 * UNIQUE (group_id, user_id)
 */
export const userSummaries = sqliteTable(
  'user_summaries',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id').notNull(),
    userId: text('user_id').notNull(),
    summary: text('summary').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => ({
    userUnique: uniqueIndex('user_summaries_user_unique').on(table.groupId, table.userId),
  }),
)

/**
 * 群組摘要表 - 每個群組的整體摘要（每群組一筆記錄）
 * CAVEAT: updatedAt 同時作為 Observer 的 watermark
 * WHY: Observer.shouldRun() 使用此欄位計算「距上次壓縮以來的訊息數」
 */
export const groupSummaries = sqliteTable(
  'group_summaries',
  {
    groupId: text('group_id').primaryKey(),
    summary: text('summary').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
)

/**
 * 用戶統計表 - 儲存每個用戶每日的統計數據
 * 複合主鍵 (group_id, user_id, date)
 * date: ISO format 'YYYY-MM-DD' in UTC
 */
export const userStats = sqliteTable(
  'user_stats',
  {
    groupId: text('group_id').notNull(),
    userId: text('user_id').notNull(),
    date: text('date').notNull(),
    messageCount: integer('message_count').notNull().default(0),
    stickerCount: integer('sticker_count').notNull().default(0),
    urlCount: integer('url_count').notNull().default(0),
    mentionCount: integer('mention_count').notNull().default(0),
  },
  table => ({
    pk: primaryKey({ columns: [table.groupId, table.userId, table.date] }),
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
    groupId: text('group_id').notNull(),
    content: text('content').notNull(),
    messageIds: text('message_ids').notNull(), // JSON array as TEXT
    startTimestamp: integer('start_timestamp').notNull(),
    endTimestamp: integer('end_timestamp').notNull(),
  },
  table => ({
    endTimestampIdx: index('chunks_end_timestamp_idx').on(table.groupId, table.endTimestamp),
  }),
)

/**
 * 頻率控制器 EMA 狀態表
 * 每個群組一筆 row，以 group_id 為 PRIMARY KEY
 * 儲存長短期 EMA 數值，供頻率控制器在重啟後恢復狀態
 */
export const frequencyState = sqliteTable('frequency_state', {
  groupId: text('group_id').primaryKey(),
  emaLongBot: real('ema_long_bot').notNull().default(0),
  emaLongTotal: real('ema_long_total').notNull().default(0),
  emaShortBot: real('ema_short_bot').notNull().default(0),
  emaShortTotal: real('ema_short_total').notNull().default(0),
  lastUpdatedAt: integer('last_updated_at').notNull().default(0),
})

/**
 * 用戶別名表 - 儲存每個群組中每個用戶的隱私別名
 * 複合主鍵 (userId, alias)，UNIQUE (group_id, alias)
 * userName: 原始用戶名稱（用於 bot 訊息儲存時的內容替換）
 * updatedAt: 別名建立或更新時間戳（Unix ms）
 */
export const userAliases = sqliteTable(
  'user_aliases',
  {
    groupId: text('group_id').notNull(),
    userId: text('user_id').notNull(),
    alias: text('alias').notNull(),
    userName: text('user_name').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.userId, table.alias] }),
    aliasUnique: uniqueIndex('user_aliases_alias_unique').on(table.groupId, table.alias),
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
    groupId: text('group_id').notNull(),
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
    scopeUserStatusIdx: index('facts_scope_user_status_idx').on(table.groupId, table.scope, table.userId, table.status),
    // NOTE: 此定義供 Drizzle ORM 型別推導用。實際的唯一索引由 initSchema() 中的 raw SQL 建立，
    // 使用 COALESCE(user_id, '') 處理 NULL 語義，並加上 WHERE status = 'active' 條件（partial index）。
    canonicalKeyUnique: uniqueIndex('facts_canonical_key_unique').on(table.groupId, table.canonicalKey, table.scope, table.userId),
  }),
)

/**
 * Fact Metadata 表 - 儲存 fact 相關的元資料（如 watermark）
 * 複合主鍵 (group_id, key)
 */
export const factMetadata = sqliteTable(
  'fact_metadata',
  {
    groupId: text('group_id').notNull(),
    key: text('key').notNull(),
    value: integer('value').notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.groupId, table.key] }),
  }),
)

/**
 * 圖片表 - 儲存訊息中的圖片縮圖與元資料
 * thumbnail: BLOB（WebP 縮圖，< 50KB）
 * description: AI 生成的精簡描述（null 表示尚未生成）
 */
export const images = sqliteTable(
  'images',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: text('group_id').notNull(),
    messageId: integer('message_id').notNull(),
    description: text('description'),
    mimeType: text('mime_type').notNull().default('image/webp'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: integer('created_at').notNull(),
    thumbnail: blob('thumbnail', { mode: 'buffer' }).notNull(),
  },
  table => ({
    messageIdx: index('images_message_idx').on(table.groupId, table.messageId),
  }),
)

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
    /** 是否曾在此批次出現 mention；一旦為 true 會持續保留 */
    isMention: integer('is_mention', { mode: 'boolean' }).notNull().default(false),
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
