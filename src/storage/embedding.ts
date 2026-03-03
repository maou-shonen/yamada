import type { EmbeddingModel } from 'ai'
import type { Database } from 'bun:sqlite'
import type { Config } from '../config'
import type { StoredMessage } from '../types'
import type { DB } from './db'
import { embed, embedMany } from 'ai'
import { asc, gte, inArray } from 'drizzle-orm'
import * as sqliteVec from 'sqlite-vec'
import { createEmbeddingModelFromId } from '../lib/provider.ts'
import { log } from '../logger'
import { buildChunks } from './chunking'
import { getMaxChunkEndTimestamp, saveChunk } from './chunks'
import * as schema from './schema'

const embeddingLog = log.withPrefix('[Embedding]')

export interface EmbeddingDeps {
  embed: typeof import('ai').embed
  embedMany: typeof import('ai').embedMany
  createEmbeddingModel: (modelId: string, config: Config) => EmbeddingModel
}

const defaultDeps: EmbeddingDeps = {
  embed,
  embedMany,
  createEmbeddingModel: createEmbeddingModelFromId,
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

  let messages: StoredMessage[] = lastTs === null
    ? drizzleDb.select().from(schema.messages).orderBy(asc(schema.messages.timestamp)).all()
    : drizzleDb.select().from(schema.messages).where(gte(schema.messages.timestamp, lastTs)).orderBy(asc(schema.messages.timestamp)).all()

  if (messages.length === 0) {
    embeddingLog.debug('No messages to process for chunking')
    return
  }

  // Cross-batch reply chain: 補抓被本批次訊息引用的 parent 訊息
  // 確保 buildChunks 能正確將 reply chain 分組
  if (lastTs !== null) {
    const batchExternalIds = new Set(
      messages.map(m => m.externalId).filter((id): id is string => id !== null),
    )
    const parentExternalIds = messages
      .map(m => m.replyToExternalId)
      .filter((id): id is string => id !== null && !batchExternalIds.has(id))

    if (parentExternalIds.length > 0) {
      const uniqueParentIds = [...new Set(parentExternalIds)]
      const parents = drizzleDb
        .select()
        .from(schema.messages)
        .where(inArray(schema.messages.externalId, uniqueParentIds))
        .all()
      // 合併 parents + messages，按 timestamp 升序排列（parents 可能已在 messages 中）
      const combined = [
        ...parents.filter(p => !messages.some(m => m.id === p.id)),
        ...messages,
      ]
      combined.sort((a, b) => a.timestamp - b.timestamp)
      messages = combined
    }
  }

  const chunks = buildChunks(messages, config.CHUNK_TOKEN_LIMIT)

  for (const chunk of chunks) {
    const chunkId = saveChunk(drizzleDb, chunk)
    const embedding = await embedText(chunk.content, config, deps)
    insertChunkVector(db, chunkId, embedding)
  }

  embeddingLog
    .withMetadata({ insertedChunks: chunks.length })
    .info('Chunk embeddings stored')
}
