import type { EmbeddingDeps } from './embedding'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { setupTestDb } from '../__tests__/helpers/setup-db.ts'
import { embedText, processNewChunks } from './embedding'
import * as schema from './schema'
import { SqliteVectorStore } from './sqlite-vector-store'

/** 測試用 Config（4 維向量，簡化測試） */
const mockConfig = createTestConfig({
  embeddingEnabled: true,
  EMBEDDING_MODEL: 'openai/text-embedding-3-small',
  EMBEDDING_DIMENSIONS: 4,
})

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
    createEmbeddingModel: (modelId: string) =>
      ({ model: modelId }) as unknown as ReturnType<EmbeddingDeps['createEmbeddingModel']>,
  }
}

let db: Database
let vectorStore: SqliteVectorStore

beforeEach(() => {
  db = new Database(':memory:')
  vectorStore = new SqliteVectorStore(db)
  vectorStore.init(4)
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

// ─── VectorStore.init() 測試 ───

test('VectorStore.init() 成功初始化不拋錯', () => {
  const freshDb = new Database(':memory:')
  const freshStore = new SqliteVectorStore(freshDb)
  expect(() => freshStore.init(4)).not.toThrow()
  freshDb.close()
})

test('VectorStore.init() 冪等：第二次呼叫不拋錯', () => {
  // vectorStore.init(4) already called in beforeEach
  expect(() => vectorStore.init(4)).not.toThrow()
})

// ─── Chunk Vector 測試 ───

test('upsertChunkVector 後 searchChunks 可找到該 id', () => {
  const embedding = [0.1, 0.2, 0.3, 0.4]
  vectorStore.upsertChunkVector(42, embedding)

  const results = vectorStore.searchChunks(embedding, 5, 999)
  expect(results.length).toBe(1)
  expect(results[0]?.id).toBe(42)
})

test('upsertChunkVector 冪等（重複呼叫不拋錯）', () => {
  const embedding = [0.1, 0.2, 0.3, 0.4]
  vectorStore.upsertChunkVector(99, embedding)
  expect(() => vectorStore.upsertChunkVector(99, embedding)).not.toThrow()
})

test('upsertChunkVector 覆寫既有向量（INSERT OR REPLACE）', () => {
  vectorStore.upsertChunkVector(1, [0.1, 0.2, 0.3, 0.4])
  vectorStore.upsertChunkVector(1, [0.9, 0.9, 0.9, 0.9])

  const results = vectorStore.searchChunks([0.9, 0.9, 0.9, 0.9], 5, 999)
  expect(results.length).toBe(1)
  expect(results[0]?.id).toBe(1)
  expect(results[0]?.distance).toBeCloseTo(0, 1)
})

// ─── searchChunks 測試 ───

test('searchChunks 回傳空陣列（無資料）', () => {
  const results = vectorStore.searchChunks([0.1, 0.2, 0.3, 0.4], 5, 999)
  expect(results).toEqual([])
})

test('searchChunks 依距離升序排列', () => {
  vectorStore.upsertChunkVector(1, [0.1, 0.2, 0.3, 0.4]) // closer
  vectorStore.upsertChunkVector(2, [0.9, 0.9, 0.9, 0.9]) // farther

  const query = [0.1, 0.2, 0.3, 0.4]
  const results = vectorStore.searchChunks(query, 5, 999)

  expect(results.length).toBe(2)
  expect(results[0]?.distance).toBeLessThanOrEqual(results[1]?.distance ?? Infinity)
  expect(results[0]?.id).toBe(1)
})

test('searchChunks threshold 過濾', () => {
  vectorStore.upsertChunkVector(1, [0.1, 0.2, 0.3, 0.4])

  // 使用差異極大的查詢向量，threshold 應過濾掉所有結果
  const results = vectorStore.searchChunks([0.9, 0.9, 0.9, 0.9], 5, 0.0001)
  expect(results).toEqual([])
})

// ─── Fact Vectors 測試 ───

describe('fact vectors', () => {
  test('upsertFactVector inserts vector without error', () => {
    expect(() => vectorStore.upsertFactVector(1, [0.1, 0.2, 0.3, 0.4])).not.toThrow()
  })

  test('upsertFactVector is idempotent (same factId again does not throw)', () => {
    vectorStore.upsertFactVector(1, [0.1, 0.2, 0.3, 0.4])
    expect(() => vectorStore.upsertFactVector(1, [0.1, 0.2, 0.3, 0.4])).not.toThrow()
  })

  test('searchFacts returns closest factId first', () => {
    vectorStore.upsertFactVector(1, [0.1, 0.2, 0.3, 0.4]) // closer
    vectorStore.upsertFactVector(2, [0.9, 0.9, 0.9, 0.9]) // farther

    const results = vectorStore.searchFacts([0.1, 0.2, 0.3, 0.4], 5, 999)
    expect(results).toHaveLength(2)
    expect(results[0].distance).toBeLessThanOrEqual(results[1].distance)
    expect(results[0].id).toBe(1)
  })

  test('searchFacts returns empty array on empty table', () => {
    const results = vectorStore.searchFacts([0.1, 0.2, 0.3, 0.4], 5, 999)
    expect(results).toEqual([])
  })

  test('searchFacts threshold filtering excludes distant results', () => {
    vectorStore.upsertFactVector(1, [0.1, 0.2, 0.3, 0.4])

    const results = vectorStore.searchFacts([0.9, 0.9, 0.9, 0.9], 5, 0.0001)
    expect(results).toEqual([])
  })

  test('deleteFactVectors removes specific vectors', () => {
    vectorStore.upsertFactVector(1, [0.1, 0.2, 0.3, 0.4])
    vectorStore.upsertFactVector(2, [0.9, 0.9, 0.9, 0.9])

    vectorStore.deleteFactVectors([1])

    const results = vectorStore.searchFacts([0.1, 0.2, 0.3, 0.4], 5, 999)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(2)
  })

  test('deleteFactVectors with empty array does not throw', () => {
    expect(() => vectorStore.deleteFactVectors([])).not.toThrow()
  })

  test('chunk 與 fact vectors 在同一 VectorStore 獨立共存', () => {
    // Insert into both with same id
    vectorStore.upsertChunkVector(1, [0.1, 0.2, 0.3, 0.4])
    vectorStore.upsertFactVector(1, [0.9, 0.8, 0.7, 0.6])

    // Search chunks — should find chunk vector
    const chunkResults = vectorStore.searchChunks([0.1, 0.2, 0.3, 0.4], 5, 999)
    expect(chunkResults).toHaveLength(1)
    expect(chunkResults[0].id).toBe(1)

    // Search facts — should find fact vector
    const factResults = vectorStore.searchFacts([0.9, 0.8, 0.7, 0.6], 5, 999)
    expect(factResults).toHaveLength(1)
    expect(factResults[0].id).toBe(1)
  })
})

// ─── VectorStore interface contract 測試 ───

test('VectorStore interface contract: insert → search returns it, delete → search does not', () => {
  vectorStore.upsertFactVector(42, [0.5, 0.5, 0.5, 0.5])

  // Search should find it
  const before = vectorStore.searchFacts([0.5, 0.5, 0.5, 0.5], 5, 999)
  expect(before).toHaveLength(1)
  expect(before[0].id).toBe(42)

  // Delete
  vectorStore.deleteFactVectors([42])

  // Search should not find it
  const after = vectorStore.searchFacts([0.5, 0.5, 0.5, 0.5], 5, 999)
  expect(after).toEqual([])
})

// ─── processNewChunks Pipeline 測試 ───

test('processNewChunks 無訊息時不插入向量', async () => {
  const { sqlite, db: drizzleDb } = setupTestDb()
  const store = new SqliteVectorStore(sqlite)
  store.init(4)
  const fakeDeps = createFakeDeps()

  await processNewChunks(store, drizzleDb, mockConfig, fakeDeps)

  const results = store.searchChunks([0.1, 0.2, 0.3, 0.4], 100, 999)
  expect(results).toEqual([])
  sqlite.close()
})

test('processNewChunks 正確處理訊息並插入 chunk 向量', async () => {
  const { sqlite, db: drizzleDb } = setupTestDb()
  const store = new SqliteVectorStore(sqlite)
  store.init(4)
  const fakeDeps = createFakeDeps()

  // 插入 2 則訊息到 DB
  drizzleDb.insert(schema.messages).values([
    { userId: 'u1', content: '第一則訊息', isBot: false, timestamp: 1000, externalId: null, replyToExternalId: null },
    { userId: 'u2', content: '第二則訊息', isBot: false, timestamp: 2000, externalId: null, replyToExternalId: null },
  ]).run()

  await processNewChunks(store, drizzleDb, mockConfig, fakeDeps)

  // chunks 表應有資料
  const chunkCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }
  expect(chunkCount.cnt).toBeGreaterThan(0)

  // vector search should find results
  const results = store.searchChunks([0.1, 0.2, 0.3, 0.4], 100, 999)
  expect(results.length).toBeGreaterThan(0)

  sqlite.close()
})
