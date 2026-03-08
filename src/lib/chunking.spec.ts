import { describe, expect, test } from 'bun:test'
import type { StoredMessage } from '../types'
import { buildChunks, type ChunkingDeps } from './chunking'

function makeMsg(overrides: Partial<StoredMessage> & { id: number; timestamp: number }): StoredMessage {
  const { id, timestamp, ...rest } = overrides

  return {
    id,
    externalId: `ext-${id}`,
    userId: 'user1',
    content: 'hello',
    isBot: false,
    timestamp,
    replyToExternalId: null,
    ...rest,
  }
}

describe('buildChunks', () => {
  test('5개 standalone 메시지 + tokenLimit 충분하면 1개 chunk', () => {
    const messages = [
      makeMsg({ id: 1, timestamp: 1000, content: 'A' }),
      makeMsg({ id: 2, timestamp: 2000, content: 'B' }),
      makeMsg({ id: 3, timestamp: 3000, content: 'C' }),
      makeMsg({ id: 4, timestamp: 4000, content: 'D' }),
      makeMsg({ id: 5, timestamp: 5000, content: 'E' }),
    ]

    const chunks = buildChunks(messages, 1000)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({
      content: 'user1: A\nuser1: B\nuser1: C\nuser1: D\nuser1: E',
      messageIds: [1, 2, 3, 4, 5],
      startTimestamp: 1000,
      endTimestamp: 5000,
    })
  })

  test('A→B→C reply chain + D/E standalone은 2개 chunk', () => {
    const messages = [
      makeMsg({ id: 1, timestamp: 1000, userId: 'uA', content: 'A', externalId: 'A' }),
      makeMsg({ id: 2, timestamp: 2000, userId: 'uB', content: 'B', externalId: 'B', replyToExternalId: 'A' }),
      makeMsg({ id: 3, timestamp: 3000, userId: 'uC', content: 'C', externalId: 'C', replyToExternalId: 'B' }),
      makeMsg({ id: 4, timestamp: 4000, userId: 'uD', content: 'D' }),
      makeMsg({ id: 5, timestamp: 5000, userId: 'uE', content: 'E' }),
    ]

    const chunks = buildChunks(messages, 1000)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({
      content: 'uA: A\nuB: B\nuC: C',
      messageIds: [1, 2, 3],
      startTimestamp: 1000,
      endTimestamp: 3000,
    })
    expect(chunks[1]).toEqual({
      content: 'uD: D\nuE: E',
      messageIds: [4, 5],
      startTimestamp: 4000,
      endTimestamp: 5000,
    })
  })

  test('orphan reply는 standalone으로 처리', () => {
    const messages = [
      makeMsg({
        id: 1,
        timestamp: 1000,
        userId: 'u1',
        content: 'orphan',
        replyToExternalId: 'missing-external-id',
      }),
    ]

    const chunks = buildChunks(messages, 1000)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({
      content: 'u1: orphan',
      messageIds: [1],
      startTimestamp: 1000,
      endTimestamp: 1000,
    })
  })

  test('긴 reply chain은 tokenLimit 초과 시 분할', () => {
    const messages = [
      makeMsg({ id: 1, timestamp: 1000, externalId: 'A', content: 'A' }),
      makeMsg({ id: 2, timestamp: 2000, externalId: 'B', content: 'B', replyToExternalId: 'A' }),
      makeMsg({ id: 3, timestamp: 3000, externalId: 'C', content: 'C', replyToExternalId: 'B' }),
      makeMsg({ id: 4, timestamp: 4000, externalId: 'D', content: 'D', replyToExternalId: 'C' }),
    ]

    const deps: ChunkingDeps = {
      estimateTokens: () => 5,
    }

    const chunks = buildChunks(messages, 10, 3, deps)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({
      content: 'user1: A\nuser1: B',
      messageIds: [1, 2, 3, 4],
      startTimestamp: 1000,
      endTimestamp: 4000,
    })
    expect(chunks[1]).toEqual({
      content: 'user1: C\nuser1: D',
      messageIds: [1, 2, 3, 4],
      startTimestamp: 1000,
      endTimestamp: 4000,
    })
  })

  test('non-embeddable 메시지는 messageIds에 포함되지만 content에는 제외', () => {
    const messages = [
      makeMsg({ id: 1, timestamp: 1000, externalId: 'A', userId: 'u1', content: 'hello' }),
      makeMsg({
        id: 2,
        timestamp: 2000,
        externalId: 'B',
        userId: 'u2',
        content: '[圖片]',
        replyToExternalId: 'A',
      }),
      makeMsg({
        id: 3,
        timestamp: 3000,
        externalId: 'C',
        userId: 'u3',
        content: 'world',
        replyToExternalId: 'B',
      }),
    ]

    const chunks = buildChunks(messages, 1000)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({
      content: 'u1: hello\nu3: world',
      messageIds: [1, 2, 3],
      startTimestamp: 1000,
      endTimestamp: 3000,
    })
  })

  test('빈 입력이면 빈 배열 반환', () => {
    expect(buildChunks([], 1000)).toEqual([])
  })

  test('전체 non-embeddable이면 빈 배열 반환 (빈 chunk 금지)', () => {
    const messages = [
      makeMsg({ id: 1, timestamp: 1000, content: '[圖片]' }),
      makeMsg({ id: 2, timestamp: 2000, content: '[貼圖]' }),
    ]

    const chunks = buildChunks(messages, 1000)

    expect(chunks).toEqual([])
  })
})
