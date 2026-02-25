import type { EmbeddingDeps } from './embedding'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import {

  embedText,
  initVectorTable,
  insertVector,
  processNewMessages,
  searchSimilar,
} from './embedding'

/** 測試用 Config（4 維向量，簡化測試） */
const mockConfig = createTestConfig({
  embeddingEnabled: true,
  EMBEDDING_MODEL: 'text-embedding-3-small',
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

test('initVectorTable 成功建立 virtual table', () => {
  // 不拋錯即成功
  expect(() => initVectorTable(db, 4)).not.toThrow()

  // 確認 message_vectors virtual table 存在
  const tables = db
    .prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name LIKE \'message_vectors%\'')
    .all() as Array<{ name: string }>
  expect(tables.length).toBeGreaterThan(0)
})

test('insertVector 後 searchSimilar 回傳該 messageId', () => {
  initVectorTable(db, 4)

  const embedding = [0.1, 0.2, 0.3, 0.4]
  insertVector(db, 1, embedding)

  const results = searchSimilar(db, embedding, 5, 999)
  expect(results.length).toBe(1)
  expect(results[0]?.messageId).toBe(1)
})

test('searchSimilar 回傳結果按距離升序排列', () => {
  initVectorTable(db, 4)

  // 兩個向量，距離不同
  insertVector(db, 1, [0.1, 0.2, 0.3, 0.4]) // 較近
  insertVector(db, 2, [0.9, 0.9, 0.9, 0.9]) // 較遠

  const query = [0.1, 0.2, 0.3, 0.4]
  const results = searchSimilar(db, query, 5, 999)

  expect(results.length).toBe(2)
  // 距離應升序排列（較近的在前）
  expect(results[0]?.distance).toBeLessThanOrEqual(results[1]?.distance ?? Infinity)
  expect(results[0]?.messageId).toBe(1)
})

test('processNewMessages 跳過空字串、[圖片]、[貼圖]', async () => {
  initVectorTable(db, 4)
  const fakeDeps = createFakeDeps()

  const messages = [
    makeMsg(1, ''),
    makeMsg(2, '[圖片]'),
    makeMsg(3, '[貼圖]'),
    makeMsg(4, '[影片]'),
  ]

  await processNewMessages(db, messages, mockConfig, fakeDeps)

  // 沒有向量被插入（message_vectors 為空）
  const rows = db.prepare('SELECT COUNT(*) as cnt FROM message_vectors').get() as { cnt: number }
  expect(rows.cnt).toBe(0)
})

test('processNewMessages 正確批次處理正常訊息', async () => {
  initVectorTable(db, 4)
  const fakeDeps = createFakeDeps()

  const messages = [
    makeMsg(1, '正常訊息一'),
    makeMsg(2, '正常訊息二'),
  ]

  await processNewMessages(db, messages, mockConfig, fakeDeps)

  // 兩個向量被插入
  const rows = db.prepare('SELECT COUNT(*) as cnt FROM message_vectors').get() as { cnt: number }
  expect(rows.cnt).toBe(2)
})

test('embedText 透過 mock 回傳向量陣列', async () => {
  const fakeDeps = createFakeDeps()
  const result = await embedText('Hello World', mockConfig, fakeDeps)
  expect(Array.isArray(result)).toBe(true)
  expect(result.length).toBe(4)
  expect(result.every(v => typeof v === 'number')).toBe(true)
})
