/**
 * 跨平台統一訊息格式
 * WHY: 解耦平台特定事件格式（Discord 的 Message、LINE 的 MessageEvent）與核心邏輯
 * 所有平台必須在進入 pipeline 前轉換為此格式，確保 Router、Debounce、Context 組裝等核心模組無需知道平台細節
 */
export interface UnifiedMessage {
  id: string
  groupId: string
  userId: string
  userName: string
  content: string
  timestamp: Date
  platform: 'discord' | 'line'
  isBot: boolean
  isMention: boolean
  raw?: unknown
  replyToExternalId?: string
  /**
   * 圖片附件（由平台層提取，背景非同步處理）
   * WHY: optional 因為絕大多數訊息無圖片；non-null entries 表示平台確認有圖片附件
   */
  images?: ImageAttachment[]
}

/** 平台通道介面（Discord / LINE 均需實作） */
export interface PlatformChannel {
  name: string
  start: () => Promise<void>
  stop: () => Promise<void>
  sendMessage: (groupId: string, content: string) => Promise<void>
  sendReaction: (groupId: string, messageId: string, emoji: string) => Promise<void>
  onMessage: (message: UnifiedMessage) => void
}

/**
 * DB 儲存的訊息格式
 * CONSTRAINT: timestamp 為 number 而非 Date
 * WHY: SQLite 原生儲存整數；在邊界層轉換保持 DB 層簡潔，避免序列化/反序列化開銷
 * NOTE: groupId 已移除——per-group DB 本身就是隔離單位，不需要 group_id 欄位
 *
 * id: number — SQLite INTEGER PRIMARY KEY AUTOINCREMENT，也是向量索引的 rowid
 * externalId: string | null — 平台訊息 ID（Discord snowflake / LINE message ID），bot 訊息為 null
 */
export interface StoredMessage {
  id: number
  externalId: string | null
  userId: string
  content: string
  isBot: boolean
  timestamp: number
  replyToExternalId: string | null
}

/**
 * DB에 저장된 chunk 형식
 * messageIds: JSON parse된 배열 (chunks.ts CRUD 레이어에서 변환)
 */
export interface StoredChunk {
  id: number
  content: string
  messageIds: number[] // CRUD 레이어에서 JSON.parse됨
  startTimestamp: number
  endTimestamp: number
}

/**
 * 平台圖片附件（UnifiedMessage 層）
 * WHY: 解耦平台特定的圖片存取方式——Discord 提供直接 URL，LINE 需要呼叫 API
 */
export interface ImageAttachment {
  /** Discord CDN 直接下載 URL；LINE 無此欄位 */
  url?: string
  /** LINE message ID，供 getMessageContent() API 使用；Discord 無此欄位 */
  platformImageId?: string
  /** MIME type（若平台提供），如 'image/jpeg', 'image/png' */
  contentType?: string
}

/**
 * DB 儲存的圖片格式
 * CONSTRAINT: thumbnail 為 Uint8Array（SQLite BLOB 在 Bun 中的原生型別）
 * WHY: 縮圖直接存 DB 確保 Litestream 備份覆蓋，不需額外檔案系統管理
 *
 * id: number — SQLite INTEGER PRIMARY KEY AUTOINCREMENT
 * messageId: number — 外鍵 → messages.id
 * thumbnail: 縮圖 BLOB（≤512px WebP）
 * description: AI 生成的精簡描述（null 表示尚未生成）
 */
export interface StoredImage {
  id: number
  groupId: string
  messageId: number
  description: string | null
  mimeType: string
  width: number
  height: number
  createdAt: number
  thumbnail: Uint8Array
}

/**
 * 用戶別名記錄
 * userId: 用戶 ID
 * alias: 隱私別名
 * userName: 原始用戶名稱
 * updatedAt: 更新時間戳（Unix ms）
 */
export interface UserAlias {
  userId: string
  alias: string
  userName: string
  updatedAt: number
}
