import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { setupTestDb } from '../__tests__/helpers/setup-db'
import { chunks, messages } from './schema'

describe('messages.replyToExternalId', () => {
  test('replyToExternalId 있는 메시지 저장 후 정확히 읽힘', async () => {
    const { db } = setupTestDb()
    const now = Date.now()

    await db.insert(messages).values({
      groupId: 'group-a',
      externalId: 'msg-reply',
      userId: 'user-1',
      content: '답장 메시지',
      isBot: false,
      timestamp: now,
      replyToExternalId: 'msg-original',
    })

    const result = await db.select().from(messages).where(eq(messages.externalId, 'msg-reply'))
    expect(result).toHaveLength(1)
    expect(result[0].replyToExternalId).toBe('msg-original')
  })

  test('replyToExternalId 없는 메시지는 null로 저장됨', async () => {
    const { db } = setupTestDb()
    const now = Date.now()

    await db.insert(messages).values({
      groupId: 'group-a',
      externalId: 'msg-no-reply',
      userId: 'user-2',
      content: '일반 메시지',
      isBot: false,
      timestamp: now,
    })

    const result = await db.select().from(messages).where(eq(messages.externalId, 'msg-no-reply'))
    expect(result).toHaveLength(1)
    expect(result[0].replyToExternalId).toBeNull()
  })
})

describe('chunks 테이블', () => {
  test('chunks INSERT 후 SELECT로 모든 필드 정확히 읽힘', async () => {
    const { db } = setupTestDb()
    const messageIds = JSON.stringify([1, 2, 3])
    const startTs = 1_700_000_000
    const endTs = 1_700_001_000

    await db.insert(chunks).values({
      groupId: 'group-a',
      content: '요약된 청크 내용',
      messageIds,
      startTimestamp: startTs,
      endTimestamp: endTs,
    })

    const result = await db.select().from(chunks)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('요약된 청크 내용')
    expect(result[0].messageIds).toBe(messageIds)
    expect(result[0].startTimestamp).toBe(startTs)
    expect(result[0].endTimestamp).toBe(endTs)
  })
})

describe('messages_external_id_idx 인덱스', () => {
  test('external_id 조회 시 messages_external_id_idx 인덱스 사용', () => {
    const { sqlite } = setupTestDb()

    // EXPLAIN QUERY PLAN 으로 인덱스 사용 여부 확인
    // Index is composite (group_id, external_id), so both columns must be in WHERE clause
    const plan = sqlite.query('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE group_id = ? AND external_id = ?').all('group-a', 'test-id')
    const planText = plan.map((row: unknown) => Object.values(row as Record<string, unknown>).join(' ')).join('\n')

    expect(planText).toContain('messages_external_id_idx')
  })
})
