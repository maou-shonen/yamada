import type { Database } from 'bun:sqlite'
import type { Config } from '../config'
import type { StoredMessage } from '../types'
import { embed, embedMany } from 'ai'
import * as sqliteVec from 'sqlite-vec'
import { createEmbeddingProvider } from '../lib/provider.ts'
import { log } from '../logger'
import { isEmbeddableContent } from '../utils/text'

const embeddingLog = log.withPrefix('[Embedding]')

export interface EmbeddingDeps {
  embed: typeof import('ai').embed
  embedMany: typeof import('ai').embedMany
  createEmbeddingModel: (modelName: string, config: Config) => ReturnType<ReturnType<typeof createEmbeddingProvider>['embedding']>
}

const defaultDeps: EmbeddingDeps = {
  embed,
  embedMany,
  createEmbeddingModel: (modelName: string, config: Config) => createEmbeddingProvider(config).embedding(modelName),
}

const toVector = (values: number[]) => new Float32Array(values)

export async function embedText(
  text: string,
  config: Config,
  deps: EmbeddingDeps = defaultDeps,
): Promise<number[]> {
  const { embedding } = await deps.embed({
    model: deps.createEmbeddingModel(config.EMBEDDING_MODEL, config),
    value: text,
  })

  return embedding
}

export async function embedTexts(
  texts: string[],
  config: Config,
  deps: EmbeddingDeps = defaultDeps,
): Promise<number[][]> {
  if (texts.length === 0)
    return []

  const { embeddings } = await deps.embedMany({
    model: deps.createEmbeddingModel(config.EMBEDDING_MODEL, config),
    values: texts,
  })

  return embeddings
}

/**
 * 初始化向量表。
 * sqlite-vec 虛擬表使用 INTEGER PRIMARY KEY 作為 rowid，
 * 直接用 message 的 integer PK 作為 rowid，無需橋接表。
 */
export function initVectorTable(db: Database, dimensions: number): void {
  sqliteVec.load(db)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS message_vectors USING vec0(
      embedding float[${dimensions}]
    )
  `)
}

/**
 * 插入向量到 sqlite-vec。
 * messageId 就是 message 的 INTEGER PRIMARY KEY，直接用作 sqlite-vec 的 rowid。
 * 使用 INSERT OR IGNORE 確保冪等性——重複處理同一訊息不會出錯。
 */
export function insertVector(
  db: Database,
  messageId: number,
  embedding: number[],
): void {
  db.prepare(
    'INSERT OR IGNORE INTO message_vectors(rowid, embedding) VALUES (?, ?)',
  ).run(messageId, toVector(embedding))
}

/**
 * 語義搜尋：直接回傳 rowid（即 message id）。
 * sqlite-vec 回傳的 rowid 就是 message 的 INTEGER PRIMARY KEY，無需額外映射。
 */
export function searchSimilar(
  db: Database,
  queryEmbedding: number[],
  topK: number,
  threshold: number,
): { messageId: number, distance: number }[] {
  // sqlite-vec 需要在 WHERE 子句中使用 `k = ?`，不支援 LIMIT ?
  const vecStmt = db.prepare(`
    SELECT rowid, distance
    FROM message_vectors
    WHERE embedding MATCH ? AND k = ?
    ORDER BY distance
  `)

  const vecRows = vecStmt.all(toVector(queryEmbedding), topK) as Array<{
    rowid: number
    distance: number
  }>

  const filtered = vecRows.filter(row => row.distance <= threshold)
  if (filtered.length === 0)
    return []

  return filtered.map(row => ({
    messageId: row.rowid,
    distance: row.distance,
  }))
}

/**
 * 批次處理新訊息的 embedding 與向量插入。
 * 每次呼叫都執行 initVectorTable（CREATE IF NOT EXISTS 冪等），
 * 確保表存在，即使是首次執行也能正常初始化。
 *
 * 先查 message_vectors 排除已有 embedding 的訊息，
 * 避免對已處理過的訊息重複呼叫 embedding API（API call 有成本且不冪等）。
 */
export async function processNewMessages(
  db: Database,
  messages: StoredMessage[],
  config: Config,
  deps: EmbeddingDeps = defaultDeps,
): Promise<void> {
  if (messages.length === 0) {
    embeddingLog.debug('No messages to process')
    return
  }

  initVectorTable(db, config.EMBEDDING_DIMENSIONS)

  const embeddable = messages.filter(message => isEmbeddableContent(message.content))
  if (embeddable.length === 0) {
    embeddingLog.withMetadata({ totalMessages: messages.length }).debug('No embeddable messages (all filtered)')
    return
  }

  // 排除已有 embedding 的訊息，避免重複呼叫 API
  const existingIds = new Set(
    embeddable
      .map((m) => {
        const row = db.prepare('SELECT 1 FROM message_vectors WHERE rowid = ?').get(m.id)
        return row ? m.id : null
      })
      .filter(Boolean) as number[],
  )

  const newMessages = embeddable.filter(m => !existingIds.has(m.id))
  if (newMessages.length === 0) {
    embeddingLog.withMetadata({ totalMessages: messages.length, alreadyEmbedded: existingIds.size }).debug('All messages already embedded')
    return
  }

  embeddingLog
    .withMetadata({
      totalMessages: messages.length,
      embeddableMessages: embeddable.length,
      alreadyEmbedded: existingIds.size,
      newMessages: newMessages.length,
    })
    .info('Processing new message embeddings')

  const embeddings = await embedTexts(
    newMessages.map(message => message.content),
    config,
    deps,
  )

  if (embeddings.length !== newMessages.length) {
    throw new Error('Embedding 數量與訊息數量不一致')
  }

  for (let i = 0; i < embeddings.length; i++) {
    const message = newMessages[i]
    insertVector(db, message.id, embeddings[i])
  }

  embeddingLog
    .withMetadata({ insertedCount: newMessages.length })
    .info('Embeddings stored')
}
