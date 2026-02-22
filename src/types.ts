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
 * id: number — SQLite INTEGER PRIMARY KEY AUTOINCREMENT，也是 sqlite-vec rowid
 * externalId: string | null — 平台訊息 ID（Discord snowflake / LINE message ID），bot 訊息為 null
 */
export interface StoredMessage {
  id: number
  externalId: string | null
  userId: string
  content: string
  isBot: boolean
  timestamp: number
}
