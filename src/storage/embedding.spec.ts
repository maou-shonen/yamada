import type { EmbeddingDeps } from './embedding'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { setupTestDb } from '../__tests__/helpers/setup-db.ts'
import {
  embedText,
  initChunkVectorTable,
  insertChunkVector,
  processNewChunks,
  searchSimilarChunks,
} from './embedding'
import * as schema from './schema'

/** 測試用 Config（4 維向量，簡化測試） */
const mockConfig = createTestConfig({
  embeddingEnabled: true,
  EMBEDDING_MODEL: 'openai/text-embedding-3-small',
  EMBEDDING_DIMENSIONS: 4,
})

/** 建立 StoredMessage 測試資料 */
function makeMsg(id: number, content: string) {
  return {
    id,
    externalId: null,
    content,
    userId: 'u1',
    isBot: false,
    timestamp: Date.now(),
    replyToExternalId: null,
  }
}

let db: Database

function createFakeDeps(): EmbeddingDeps {
  const fakeEmbed = mock(async () => ({
    embedding: Array.from({ length: 4 }).fill(0.1),
  })) as unknown as EmbeddingDeps['embed']

  const fakeEmbedMany = mock(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => Array.from({ length: 4 }).fill(0.1)),
  })) as unknown as EmbeddingDeps['embedMany']

  return {
    embed: fakeEmbed,
    embedMany: fakeEmbedMany,
    createEmbeddingModel: (modelName: string) => ({ model: modelName }) as unknown as ReturnType<EmbeddingDeps['createEmbeddingModel']>,
  }
}

beforeEach(() => {
  db = new Database(':memory:')
})

afterEach(() => {
  db.close()
})

test('embedText 透過 mock 回傳向量陣列', async () => {
  const fakeDeps = createFakeDeps()
  const result = await embedText('Hello World', mockConfig, fakeDeps)
  expect(Array.isArray(result)).toBe(true)
  expect(result.length).toBe(4)
  expect(result.every(v => typeof v === 'number')).toBe(true)
})

// ─── Chunk Embedding Pipeline 測試 ───

test('initChunkVectorTable 成功建立 chunk_vectors virtual table', () => {
  // 不拋錯即成功
  expect(() => initChunkVectorTable(db, 4)).not.toThrow()

  // 確認 chunk_vectors virtual table 存在
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chunk_vectors%'")
    .all() as Array<{ name: string }>
  expect(tables.length).toBeGreaterThan(0)
})

test('initChunkVectorTable 冪等：第二次呼叫不拋錯', () => {
  expect(() => initChunkVectorTable(db, 4)).not.toThrow()
  expect(() => initChunkVectorTable(db, 4)).not.toThrow()
})

test('insertChunkVector 後可查詢到 rowid', () => {
  initChunkVectorTable(db, 4)

  const embedding = [0.1, 0.2, 0.3, 0.4]
  insertChunkVector(db, 42, embedding)

  const row = db.prepare('SELECT rowid FROM chunk_vectors WHERE rowid = ?').get(42) as { rowid: number } | null
  expect(row).not.toBeNull()
  expect(row?.rowid).toBe(42)
})

test('insertChunkVector INSERT OR IGNORE 冪等', () => {
  initChunkVectorTable(db, 4)

  const embedding = [0.1, 0.2, 0.3, 0.4]
  insertChunkVector(db, 99, embedding)
  // 重複插入不拋錯
  expect(() => insertChunkVector(db, 99, embedding)).not.toThrow()
})

test('processNewChunks 無訊息時不插入向量', async () => {
  const { sqlite, db: drizzleDb } = setupTestDb()
  initChunkVectorTable(sqlite, 4)
  const fakeDeps = createFakeDeps()

  await processNewChunks(sqlite, drizzleDb, mockConfig, fakeDeps)

  const rows = sqlite.prepare('SELECT COUNT(*) as cnt FROM chunk_vectors').get() as { cnt: number }
  expect(rows.cnt).toBe(0)
  sqlite.close()
})

test('processNewChunks 正確處理訊息並插入 chunk 向量', async () => {
  const { sqlite, db: drizzleDb } = setupTestDb()
  initChunkVectorTable(sqlite, 4)
  const fakeDeps = createFakeDeps()

  // 插入 2 則訊息到 DB
  drizzleDb.insert(schema.messages).values([
    { userId: 'u1', content: '第一則訊息', isBot: false, timestamp: 1000, externalId: null, replyToExternalId: null },
    { userId: 'u2', content: '第二則訊息', isBot: false, timestamp: 2000, externalId: null, replyToExternalId: null },
  ]).run()

  await processNewChunks(sqlite, drizzleDb, mockConfig, fakeDeps)

  // chunks 表應有資料
  const chunkCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }
  expect(chunkCount.cnt).toBeGreaterThan(0)

  // chunk_vectors 表應有對應的向量
  const vecCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM chunk_vectors').get() as { cnt: number }
  expect(vecCount.cnt).toBeGreaterThan(0)

  sqlite.close()
})

// ─── searchSimilarChunks 測試 ───

test('searchSimilarChunks 回傳空陣列（無資料）', () => {
  initChunkVectorTable(db, 4)
  const results = searchSimilarChunks(db, [0.1, 0.2, 0.3, 0.4], 5, 999)
  expect(results).toEqual([])
})

test('insertChunkVector 後 searchSimilarChunks 回傳該 chunkId', () => {
  initChunkVectorTable(db, 4)

  const embedding = [0.1, 0.2, 0.3, 0.4]
  insertChunkVector(db, 1, embedding)

  const results = searchSimilarChunks(db, embedding, 5, 999)
  expect(results.length).toBe(1)
  expect(results[0]?.chunkId).toBe(1)
})

test('searchSimilarChunks 依距離升序排列', () => {
  initChunkVectorTable(db, 4)

  insertChunkVector(db, 1, [0.1, 0.2, 0.3, 0.4]) // 較近
  insertChunkVector(db, 2, [0.9, 0.9, 0.9, 0.9]) // 較遠

  const query = [0.1, 0.2, 0.3, 0.4]
  const results = searchSimilarChunks(db, query, 5, 999)

  expect(results.length).toBe(2)
  // 距離應升序排列（較近的在前）
  expect(results[0]?.distance).toBeLessThanOrEqual(results[1]?.distance ?? Infinity)
  expect(results[0]?.chunkId).toBe(1)
})

test('searchSimilarChunks threshold 過濾', () => {
  initChunkVectorTable(db, 4)
  insertChunkVector(db, 1, [0.1, 0.2, 0.3, 0.4])

  // 使用差異極大的查詢向量，確保距離 >> 0.0001，threshold 應過濾掉所有結果
  const results = searchSimilarChunks(db, [0.9, 0.9, 0.9, 0.9], 5, 0.0001)
  expect(results).toEqual([])
})
