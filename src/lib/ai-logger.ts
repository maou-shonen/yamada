import type { LogLayer } from 'loglayer'
import { Buffer } from 'node:buffer'
import { aiLog as defaultAiLog } from '../logger'

export interface AiLogEntry {
  callType: 'chat' | 'observer-group' | 'observer-user' | 'fact-extraction' | 'vision'
  groupId: string
  model: string
  durationMs: number
  input: unknown
  output: unknown
  usage?: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
  }
  error?: unknown
  attempt?: number
  totalAttempts?: number
}

/**
 * 記錄一次 AI 請求到獨立的 ai-*.log 檔案。
 * WHY 獨立函式：集中 AI log 的序列化邏輯，避免各呼叫點重複處理。
 */
export function logAiRequest(entry: AiLogEntry, logger: LogLayer = defaultAiLog): void {
  const isError = entry.error !== undefined
  const message = `${entry.callType} ${isError ? 'failed' : 'completed'}`
  logger.withMetadata(entry as unknown as Record<string, unknown>).info(message)
}

/**
 * 清理 messages array，將 Buffer 替換為 metadata，防止巨量 binary 寫入 log。
 * WHY：Vision 呼叫的 ModelMessage 含 Buffer，JSON.stringify 會產生 {"type":"Buffer","data":[...]}。
 */
export function sanitizeMessagesForLog(messages: unknown[]): unknown[] {
  return messages.map(msg => sanitizeValue(msg))
}

function sanitizeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { type: 'image-binary', byteLength: value.byteLength }
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue)
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeValue(v)
    }
    return result
  }
  return value
}
