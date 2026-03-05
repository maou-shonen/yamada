import type { EmbeddingModel } from 'ai'
import type { Config } from '../config'
import type { StoredMessage } from '../types'
import type { DB } from './db'
import type { VectorStore } from './vector-store'
import { embed, embedMany } from 'ai'
import { asc, gte, inArray } from 'drizzle-orm'
import { createEmbeddingModelFromId } from '../lib/provider.ts'
import { log } from '../logger'
import { buildChunks } from './chunking'
import { getMaxChunkEndTimestamp, saveChunk } from './chunks'
import { getAllActiveFacts } from './facts'
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
 * 批次處理新 chunk 的 embedding 與向量插入。
 * Step 1: 查詢最後處理的 chunk end_timestamp，決定從哪式訊息開始處理。
 * Step 2: 查詢訊息（全部或指定時間之後）。
 * Step 3: buildChunks 將訊息分組為 chunks。
 * Step 4: 對每個 chunk saveChunk + embedText + upsertChunkVector。
 */
export async function processNewChunks(
  vectorStore: VectorStore,
  drizzleDb: DB,
  config: Config,
  deps: EmbeddingDeps = defaultDeps,
): Promise<void> {
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
    vectorStore.upsertChunkVector(chunkId, embedding)
  }

  embeddingLog
    .withMetadata({ insertedChunks: chunks.length })
    .info('Chunk embeddings stored')
}

/**
 * 更新 fact embedding watermark，供下次偵測是否需重建向量。
 *
 * WHY：避免主流程混入 metadata 寫入細節，並確保更新語意集中。
 */
function updateFactEmbedWatermark(drizzleDb: DB): void {
  const now = Date.now()
  drizzleDb.insert(schema.factMetadata)
    .values({ key: 'fact_embed_watermark', value: now })
    .onConflictDoUpdate({
      target: schema.factMetadata.key,
      set: { value: now },
    })
    .run()
}

/**
 * 批次處理 fact embedding。
 * 取得所有 active facts，批次 embed 後 upsert（覆寫既有向量）。
 */
export async function processNewFactEmbeddings(
  vectorStore: VectorStore,
  drizzleDb: DB,
  config: Config,
  deps: EmbeddingDeps = defaultDeps,
): Promise<void> {
  // ── 1) 取得所有 active facts ──
  const allFacts = getAllActiveFacts(drizzleDb)
  if (allFacts.length === 0) {
    embeddingLog.debug('No facts to process for embedding')
    return
  }

  // ── 2) 批次 embedding 並 upsert 向量（覆寫既有） ──
  const texts = allFacts.map(f => f.content)
  const embeddings = await embedTexts(texts, config, deps)

  for (let i = 0; i < allFacts.length; i++) {
    vectorStore.upsertFactVector(allFacts[i].id, embeddings[i])
  }

  // ── 3) 更新 embedding watermark ──
  updateFactEmbedWatermark(drizzleDb)

  embeddingLog
    .withMetadata({ insertedFactVectors: allFacts.length })
    .info('Fact embeddings stored')
}
