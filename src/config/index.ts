import process from 'node:process'
import { z } from 'zod'
import { DEFAULT_SOUL } from './soul.ts'

// ────────────────────────────────────────────
// 單一 Zod schema — 所有設定皆從環境變數讀取
// 每個欄位同時定義：型別、驗證規則、預設值
// ────────────────────────────────────────────

const configSchema = z.object({
  // ── 秘密憑證（平台啟用由這些欄位的有無自動判斷） ──

  DISCORD_TOKEN: z.string().min(1).optional(),
  DISCORD_CLIENT_ID: z.string().min(1).optional(),
  LINE_CHANNEL_SECRET: z.string().min(1).optional(),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().min(1).optional(),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().min(1).optional(),

  // ── 人格與基本設定 ──

  /** Bot 人格 system prompt */
  SOUL: z.string().min(1).default(DEFAULT_SOUL),
  /** 群組 SQLite 資料庫目錄路徑，每個群組一個 {groupId}.db 檔案 */
  DB_DIR: z.string().default('./data/groups/'),
  /** Discord groupId 取用模式：'guild' = 同 server 共用 / 'channel' = 每頻道獨立 */
  DISCORD_GROUP_ID_MODE: z.enum(['guild', 'channel']).default('guild'),
  /** LINE Webhook 監聽埠 */
  LINE_WEBHOOK_PORT: z.coerce.number().int().min(0).max(65535).default(3000),

  // ── AI 模型 ──

  /** AI provider 名稱，對應 Vercel AI SDK 的 provider registry */
  AI_PROVIDER: z.string().min(1).default('openai'),
  /** 對話生成模型 ID */
  AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  /** Observer 摘要壓縮用的模型 ID */
  OBSERVER_MODEL: z.string().min(1).default('gpt-4o-mini'),

  // ── Embedding ──

  /** Embedding 模型 ID */
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  /** 向量維度，需與模型輸出維度一致 */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  // ── Debounce — 控制何時觸發 AI 回覆 ──

  /** 靜默觸發：最後一則訊息後 N ms 無新訊息即觸發 */
  DEBOUNCE_SILENCE_MS: z.coerce.number().int().min(0).default(15000),
  /** @mention 急迫模式：被 mention 時改用較短的等待時間 */
  DEBOUNCE_URGENT_MS: z.coerce.number().int().min(0).default(2000),
  /** 溢出觸發：buffer 累積字元超過此值即立刻觸發 */
  DEBOUNCE_OVERFLOW_CHARS: z.coerce.number().int().positive().default(3000),

  // ── Frequency — 回應頻率控制 ──

  /** 頻率控制器總開關 */
  FREQUENCY_ENABLED: z.preprocess(v => v === 'true' || v === '1', z.boolean()).default(true),
  /** 長期 EMA 半衰期（小時），預設 5 天 */
  FREQUENCY_LONG_HALFLIFE_HOURS: z.coerce.number().positive().default(120),
  /** 短期 EMA 半衰期（小時），防止連發 */
  FREQUENCY_SHORT_HALFLIFE_HOURS: z.coerce.number().positive().default(4),
  /** 計算活躍人數的時間窗口（天） */
  FREQUENCY_ACTIVE_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  // ── Scheduler — 排程器輪詢設定 ──

  /** 排程器輪詢間隔（ms），控制檢查 pending triggers 的頻率 */
  SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),

  // ── Context — 控制送給 AI 的上下文內容 ──

  /** system prompt + 摘要的 token 預算上限，超過時依序裁剪語義搜尋 → 用戶摘要 */
  CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(4000),
  /** 語義搜尋回傳的最大筆數 */
  CONTEXT_SEMANTIC_TOP_K: z.coerce.number().int().positive().default(5),
  /** 語義搜尋的距離閾值，越小越嚴格（0~2 為 cosine distance 合理範圍） */
  CONTEXT_SEMANTIC_THRESHOLD: z.coerce.number().min(0).max(2).default(0.7),
  /** 從 DB 取近期訊息的筆數，作為 AI 對話歷史 */
  CONTEXT_RECENT_MESSAGE_COUNT: z.coerce.number().int().positive().default(20),
  /** token 估算比率：每 N 個字元約為 1 token */
  CONTEXT_TOKEN_ESTIMATE_RATIO: z.coerce.number().positive().default(3),
  /** Chunk 分割的 token 上限（每個 chunk 的最大 token 數） */
  CHUNK_TOKEN_LIMIT: z.coerce.number().int().positive().default(500),

  // ── Observer — 背景記憶壓縮 ──

  /** 上次壓縮後累積多少則訊息才觸發新一輪壓縮 */
  OBSERVER_MESSAGE_THRESHOLD: z.coerce.number().int().positive().default(50),
  /** 壓縮單一用戶摘要時，從 DB 取最近 N 則該用戶訊息 */
  OBSERVER_USER_MESSAGE_LIMIT: z.coerce.number().int().positive().default(50),

  // ── Delivery — 訊息投遞與平台限制 ──

  /** Discord 單則訊息字元上限，超過會被截斷 */
  DELIVERY_DISCORD_MAX_LENGTH: z.coerce.number().int().positive().default(2000),
  /** LINE 單則訊息字元上限，超過會被截斷 */
  DELIVERY_LINE_MAX_LENGTH: z.coerce.number().int().positive().default(5000),
  /** 私訊（DM）時的自動回覆文字 */
  DELIVERY_DM_REPLY_TEXT: z.string().default('暫不支援私訊功能'),
  /** LINE replyToken 快取有效時間（ms）；實際 TTL ~60s，預設 50s 為安全邊際。過期後 fallback 到 pushMessage */
  DELIVERY_REPLY_TOKEN_FRESHNESS_MS: z.coerce.number().int().positive().default(50000),

  // ── Bot 身份 — 儲存 bot 訊息時使用的識別資料 ──

  /** Bot 的 userId，用於 DB 記錄 */
  BOT_USER_ID: z.string().default('bot'),
  /** Bot 的顯示名稱，用於 DB 記錄 */
  BOT_USER_NAME: z.string().default('Bot'),

  // ── Logging — 日誌輪替 ──

  /** 日誌檔案輸出目錄 */
  LOG_DIR: z.string().default('./logs'),
  /** 輪替頻率：'daily' | 'hourly' 等 */
  LOG_ROTATION_FREQUENCY: z.string().default('daily'),
  /** 單一日誌檔案大小上限，超過也會觸發輪替 */
  LOG_MAX_SIZE: z.string().default('100M'),
  /** 日誌最大保留時間，超過自動刪除 */
  LOG_MAX_RETENTION: z.string().default('30d'),

  // ── Shutdown — Agent 關閉行為 ──

  /** 等待進行中 AI pipeline 完成的最大時間（ms） */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  /** 輪詢 isProcessing 狀態的間隔（ms） */
  SHUTDOWN_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(100),
})

// ────────────────────────────────────────────
// loadConfig
// ────────────────────────────────────────────

/**
 * 載入完整設定
 *
 * - 所有設定皆從環境變數 / .env 讀取，由 Zod schema 驗證並提供預設值
 * - Discord / LINE 為可選平台，有完整憑證時自動啟用
 *
 * @param env - 環境變數來源（預設為 process.env，測試時可傳入自訂物件）
 */
export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const config = configSchema.parse(env)

  return {
    ...config,

    // ── 計算屬性（由憑證有無自動判斷） ──
    discordEnabled: !!(config.DISCORD_TOKEN && config.DISCORD_CLIENT_ID),
    lineEnabled: !!(config.LINE_CHANNEL_SECRET && config.LINE_CHANNEL_ACCESS_TOKEN),
    // embedding 啟用條件：有任何可用的 API 憑證即可。
    // createEmbeddingProvider fallback 鏈：EMBEDDING_* → AI_* → defaultOpenAI（讀 OPENAI_API_KEY）。
    // 因此只設 OPENAI_API_KEY（最常見場景）時也應啟用。
    embeddingEnabled: !!(
      config.EMBEDDING_BASE_URL
      || config.EMBEDDING_API_KEY
      || config.AI_BASE_URL
      || config.AI_API_KEY
      || env.OPENAI_API_KEY
    ),
  }
}

/** 完整設定型別（從 loadConfig 回傳值推導，永遠與實作同步） */
export type Config = ReturnType<typeof loadConfig>
