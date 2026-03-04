import type { Config } from '../../config/index.ts'

/** 建立測試用 Config（全部可選覆寫，預設值合理） */
export function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    // ── 平台憑證 ──
    DISCORD_TOKEN: undefined,
    DISCORD_CLIENT_ID: undefined,
    LINE_CHANNEL_SECRET: undefined,
    LINE_CHANNEL_ACCESS_TOKEN: undefined,

    // ── Per-provider AI 憑證 ──
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
    GOOGLE_API_KEY: undefined,
    GOOGLE_BASE_URL: undefined,
    OPENROUTER_API_KEY: undefined,
    OPENROUTER_BASE_URL: undefined,
    OPENCODE_API_KEY: undefined,
    OPENCODE_BASE_URL: undefined,

    // ── 人格與基本設定 ──
    SOUL: 'test soul',
    DB_DIR: '/tmp/test-groups/',
    DISCORD_GROUP_ID_MODE: 'guild',
    LINE_WEBHOOK_PORT: 3000,
    HEALTH_PORT: 3000,

    // ── AI 模型（provider/model 格式） ──
    CHAT_MODEL: 'openai/gpt-4o-mini',
    OBSERVER_MODEL: 'openai/gpt-4o-mini',

    // ── Embedding ──
    EMBEDDING_MODEL: 'openai/text-embedding-3-small',
    EMBEDDING_DIMENSIONS: 1536,

    // ── Debounce ──
    DEBOUNCE_SILENCE_MS: 15000,
    DEBOUNCE_URGENT_MS: 2000,
    DEBOUNCE_OVERFLOW_CHARS: 3000,

    // ── Frequency ──
    FREQUENCY_ENABLED: true,
    FREQUENCY_LONG_HALFLIFE_HOURS: 120,
    FREQUENCY_SHORT_HALFLIFE_HOURS: 4,
    FREQUENCY_ACTIVE_WINDOW_DAYS: 7,
    FREQUENCY_MIN_TARGET: 0.1,

    // ── Scheduler ──
    SCHEDULER_POLL_INTERVAL_MS: 2000,

    // ── Context ──
    CONTEXT_MAX_TOKENS: 4000,
    CONTEXT_SEMANTIC_TOP_K: 5,
    CONTEXT_SEMANTIC_THRESHOLD: 0.7,
    CONTEXT_RECENT_MESSAGE_COUNT: 20,
    CONTEXT_TOKEN_ESTIMATE_RATIO: 3,
    CHUNK_TOKEN_LIMIT: 500,
    CONTEXT_FACT_TOP_K: 5,
    CONTEXT_FACT_THRESHOLD: 0.7,
    FACT_CONFIDENCE_THRESHOLD: 0.5,
    FACT_MAX_PINNED: 4,

    // ── Observer ──
    OBSERVER_MESSAGE_THRESHOLD: 50,
    OBSERVER_USER_MESSAGE_LIMIT: 50,

    // ── Delivery ──
    DELIVERY_DISCORD_MAX_LENGTH: 2000,
    DELIVERY_LINE_MAX_LENGTH: 5000,
    DELIVERY_DM_REPLY_TEXT: '暫不支援私訊功能',
    DELIVERY_REPLY_TOKEN_FRESHNESS_MS: 30000,

    // ── Bot 身份 ──
    BOT_USER_ID: 'bot',
    BOT_USER_NAME: 'Bot',

    // ── Logging ──
    LOG_DIR: './logs',
    LOG_ROTATION_FREQUENCY: 'daily',
    LOG_MAX_SIZE: '50M',
    LOG_MAX_RETENTION: '14d',

    // ── Shutdown ──
    SHUTDOWN_TIMEOUT_MS: 30000,
    SHUTDOWN_POLL_INTERVAL_MS: 100,

    // ── 計算屬性 ──
    discordEnabled: false,
    lineEnabled: false,
    embeddingEnabled: false,

    ...overrides,
  }
}
