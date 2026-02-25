import type { Database } from 'bun:sqlite'
import type { Config } from '../config'
import type { StoredMessage } from '../types'
import { asc, gt } from 'drizzle-orm'
import { embed, embedMany } from 'ai'
import * as sqliteVec from 'sqlite-vec'
import { createEmbeddingProvider } from '../lib/provider.ts'
import { log } from '../logger'
import { buildChunks } from './chunking'
import { getMaxChunkEndTimestamp, saveChunk } from './chunks'
import type { DB } from './db'
import * as schema from './schema'
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

/**
 * 初始化 chunk 向量表。
 * sqlite-vec 虛擬表使用 INTEGER PRIMARY KEY 作為 rowid，
 * 直接用 chunk 的 integer PK 作為 rowid。
 */
export function initChunkVectorTable(db: Database, dimensions: number): void {
  sqliteVec.load(db)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
      embedding float[${dimensions}]
    )
  `)
}

/**
 * 插入 chunk 向量到 sqlite-vec。
 * chunkId 就是 chunk 的 INTEGER PRIMARY KEY，直接用作 sqlite-vec 的 rowid。
 * 先查詢是否已存在，再插入以確保冪等性。
 * 注意：sqlite-vec 虛擬表不支援 INSERT OR IGNORE，必須手動檢查重複。
 */
export function insertChunkVector(
  db: Database,
  chunkId: number,
  embedding: number[],
): void {
  const exists = db.prepare('SELECT 1 FROM chunk_vectors WHERE rowid = ?').get(chunkId)
  if (!exists) {
    db.prepare(
      'INSERT INTO chunk_vectors(rowid, embedding) VALUES (?, ?)',
    ).run(chunkId, toVector(embedding))
  }
}

/**
 * 語義搜尋：直接回傳 rowid（即 chunk id）。
 * sqlite-vec 回傳的 rowid 就是 chunk 的 INTEGER PRIMARY KEY，無需額外映射。
 */
export function searchSimilarChunks(
  db: Database,
  queryEmbedding: number[],
  topK: number,
  threshold: number,
): { chunkId: number, distance: number }[] {
  // sqlite-vec 需要在 WHERE 子句中使用 `k = ?`，不支援 LIMIT ?
  const vecStmt = db.prepare(`
    SELECT rowid, distance
    FROM chunk_vectors
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
    chunkId: row.rowid,
    distance: row.distance,
  }))
}

/**
 * 批次處理新 chunk 的 embedding 與向量插入。
 * Step 1: 查詢最後處理的 chunk end_timestamp，決定從哪式訊息開始處理。
 * Step 2: 查詢訊息（全部或指定時間之後）。
 * Step 3: buildChunks 將訊息分組為 chunks。
 * Step 4: 對每個 chunk saveChunk + embedText + insertChunkVector。
 */
export async function processNewChunks(
  db: Database,
  drizzleDb: DB,
  config: Config,
  deps: EmbeddingDeps = defaultDeps,
): Promise<void> {
  initChunkVectorTable(db, config.EMBEDDING_DIMENSIONS)

  const lastTs = getMaxChunkEndTimestamp(drizzleDb)

  const messages: StoredMessage[] = lastTs === null
    ? drizzleDb.select().from(schema.messages).orderBy(asc(schema.messages.timestamp)).all()
    : drizzleDb.select().from(schema.messages).where(gt(schema.messages.timestamp, lastTs)).orderBy(asc(schema.messages.timestamp)).all()

  if (messages.length === 0) {
    embeddingLog.debug('No messages to process for chunking')
    return
  }

  const chunks = buildChunks(messages, 500)

  for (const chunk of chunks) {
    const chunkId = saveChunk(drizzleDb, chunk)
    const embedding = await embedText(chunk.content, config, deps)
    insertChunkVector(db, chunkId, embedding)
  }

  embeddingLog
    .withMetadata({ insertedChunks: chunks.length })
    .info('Chunk embeddings stored')
}
