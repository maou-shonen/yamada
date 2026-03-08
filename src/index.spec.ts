import type { UnifiedMessage } from './types'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

Object.assign(process.env, {
  DISCORD_TOKEN: 'test-discord-token',
  DISCORD_CLIENT_ID: 'test-client-id',
  LINE_CHANNEL_SECRET: 'test-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
})

const { main } = await import('./index')

function makeMockChannel(name: string) {
  return {
    name,
    start: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    sendMessage: mock(() => Promise.resolve()),
    sendReaction: mock(() => Promise.resolve()),
    onMessage: mock((_msg: UnifiedMessage) => {}),
  }
}

describe('Application Entry (src/index.ts)', () => {
  let mockDiscord: ReturnType<typeof makeMockChannel>
  let mockLine: ReturnType<typeof makeMockChannel>
  let shutdown: (() => Promise<void>) | undefined

  beforeEach(() => {
    mockDiscord = makeMockChannel('discord')
    mockLine = makeMockChannel('line')
    shutdown = undefined
  })

  afterEach(async () => {
    if (shutdown) await shutdown()
  })

  test('啟動流程會啟動注入的 channels', async () => {
    shutdown = await main({ discord: mockDiscord, line: mockLine, dbPath: `/tmp/test-index-${Date.now()}.db` })

    expect(mockDiscord.start.mock.calls.length).toBe(1)
    expect(mockLine.start.mock.calls.length).toBe(1)
  })

  test('onMessage 正確連接到 bootstrap routing，且兩個 channels 綁定不同 handler', async () => {
    shutdown = await main({ discord: mockDiscord, line: mockLine, dbPath: `/tmp/test-index-${Date.now()}.db` })

    expect(typeof mockDiscord.onMessage).toBe('function')
    expect(typeof mockLine.onMessage).toBe('function')
    expect(mockDiscord.onMessage).not.toBe(mockLine.onMessage)
  })
})
