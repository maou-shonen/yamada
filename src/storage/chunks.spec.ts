import { describe, expect, test } from 'bun:test'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import {
  getChunkById,
  getChunkContents,
  getChunksByMessageIds,
  getMaxChunkEndTimestamp,
  saveChunk,
} from './chunks'

describe('Chunk CRUD', () => {
  const groupId = 'group-a'

  test('saveChunk → getChunkById: 저장 후 정확히 읽힘 (messageIds JSON 자동 변환)', () => {
    const { db } = setupTestDb()
    const chunkId = saveChunk(db, groupId, {
      content: 'A: hello\nB: hi',
      messageIds: [1, 2, 3],
      startTimestamp: 1000,
      endTimestamp: 2000,
    })
    const chunk = getChunkById(db, groupId, chunkId)
    expect(chunk).not.toBeNull()
    expect(chunk!.content).toBe('A: hello\nB: hi')
    expect(chunk!.messageIds).toEqual([1, 2, 3])
    expect(chunk!.startTimestamp).toBe(1000)
    expect(chunk!.endTimestamp).toBe(2000)
  })

  test('getChunkById: 없는 ID → null', () => {
    const { db } = setupTestDb()
    expect(getChunkById(db, groupId, 9999)).toBeNull()
  })

  test('getMaxChunkEndTimestamp: 비어있을 때 null', () => {
    const { db } = setupTestDb()
    expect(getMaxChunkEndTimestamp(db, groupId)).toBeNull()
  })

  test('getMaxChunkEndTimestamp: 여러 chunk 중 최대값 반환', () => {
    const { db } = setupTestDb()
    saveChunk(db, groupId, { content: 'a', messageIds: [1], startTimestamp: 100, endTimestamp: 500 })
    saveChunk(db, groupId, { content: 'b', messageIds: [2], startTimestamp: 200, endTimestamp: 1000 })
    saveChunk(db, groupId, { content: 'c', messageIds: [3], startTimestamp: 300, endTimestamp: 750 })
    expect(getMaxChunkEndTimestamp(db, groupId)).toBe(1000)
  })

  test('getChunksByMessageIds: 지정된 message ID를 포함하는 chunks 반환', () => {
    const { db } = setupTestDb()
    saveChunk(db, groupId, { content: 'a', messageIds: [1, 2], startTimestamp: 100, endTimestamp: 200 })
    saveChunk(db, groupId, { content: 'b', messageIds: [3, 4], startTimestamp: 300, endTimestamp: 400 })
    const result = getChunksByMessageIds(db, groupId, [2, 99])
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('a')
  })

  test('getChunkContents: chunk ID 목록으로 content 배열 반환 (순서 유지)', () => {
    const { db } = setupTestDb()
    const id1 = saveChunk(db, groupId, { content: 'first', messageIds: [1], startTimestamp: 100, endTimestamp: 200 })
    const id2 = saveChunk(db, groupId, { content: 'second', messageIds: [2], startTimestamp: 200, endTimestamp: 300 })
    const result = getChunkContents(db, groupId, [id2, id1])
    expect(result).toEqual(['second', 'first'])
  })

  test('getChunkContents: 빈 배열 → 빈 배열', () => {
    const { db } = setupTestDb()
    expect(getChunkContents(db, groupId, [])).toEqual([])
  })

  test('cross-group isolation: 다른 groupId의 chunks는 조회되지 않음', () => {
    const { db } = setupTestDb()
    const groupA = 'group-a'
    const groupB = 'group-b'
    const id1 = saveChunk(db, groupA, { content: 'a', messageIds: [1], startTimestamp: 100, endTimestamp: 200 })
    saveChunk(db, groupB, { content: 'b', messageIds: [1], startTimestamp: 100, endTimestamp: 200 })
    const chunk = getChunkById(db, groupA, id1)
    expect(chunk).not.toBeNull()
    expect(chunk!.content).toBe('a')
    expect(getChunkById(db, groupB, id1)).toBeNull()
  })
})
