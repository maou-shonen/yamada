import type { Mock } from 'bun:test'
import type { UnifiedMessage } from '../types.ts'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'

// ─── Mock 輔助型別 ───────────────────────────────────────────────

/** 模擬 discord.js Message 的最小介面 */
interface MockMessage {
  id: string
  content: string
  author: { id: string, displayName: string, bot: boolean }
  guild: { id: string } | null
  channel: { id: string, send: Mock<(c: string) => Promise<void>>, messages: { fetch: Mock<(id: string) => Promise<{ react: Mock<(e: string) => Promise<void>> }>> } }
  attachments: { size: number, values: () => Array<{ url: string, contentType: string | null }> }
  stickers: { size: number }
  mentions: { users: { has: (id: string) => boolean }, everyone: boolean }
  createdAt: Date
  reference?: { messageId?: string } | null
}

// ─── Mock discord.js Client ──────────────────────────────────────

/** 事件監聽器儲存空間 */
type Listener = (...args: unknown[]) => void
const eventListeners: Record<string, Listener[]> = {}

/** 模擬的 client.user（登入後才有） */
const mockClientUser = { id: 'bot-user-id' }

/** 模擬 channels.fetch */
const mockChannelsFetch = mock(async (_id: string) => null as unknown)

/** MockClient：模擬 discord.js Client 的行為，支援 on / once / login / destroy */
class MockClient {
  user = mockClientUser
  channels = { fetch: mockChannelsFetch }

  constructor(_opts?: unknown) {
    // 每次建立新 Client 時清空監聽器
    for (const key of Object.keys(eventListeners)) {
      delete eventListeners[key]
    }
  }

  on(event: string, listener: Listener) {
    eventListeners[event] ??= []
    eventListeners[event].push(listener)
    return this
  }

  once(event: string, listener: Listener) {
    eventListeners[event] ??= []
    eventListeners[event].push(listener)
    return this
  }

  async login(_token: string) {
    // 登入後立即觸發 ready 事件
    const readyListeners = eventListeners.ready ?? []
    for (const listener of readyListeners) {
      listener()
    }
  }

  destroy() {
    // no-op
  }
}

/** 觸發 messageCreate 事件（模擬 Discord Gateway 推送） */
function emitMessageCreate(message: MockMessage) {
  const listeners = eventListeners.messageCreate ?? []
  for (const listener of listeners) {
    listener(message)
  }
}

// Mock discord.js 模組
mock.module('discord.js', () => ({
  Client: MockClient,
  Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  // ChannelType.GuildText = 0 (discord.js 실제 값과 동일)
  ChannelType: { GuildText: 0 },
}))

// 在 mock.module 之後才 import，確保使用 mock 版本
const { DiscordChannel } = await import('./channel.ts')

// ─── 測試輔助 ────────────────────────────────────────────────────

/** 建立測試用 MockMessage */
function createMockMessage(overrides: Partial<MockMessage> = {}): MockMessage {
  const attachmentsList: Array<{ url: string, contentType: string | null }> = []
  return {
    id: 'msg-123',
    content: '你好世界',
    author: { id: 'user-456', displayName: 'TestUser', bot: false },
    guild: { id: 'guild-789' },
    channel: {
      id: 'channel-101',
      send: mock(async () => {}),
      messages: {
        fetch: mock(async () => ({
          react: mock(async () => {}),
        })),
      },
    },
    attachments: { size: 0, values: () => attachmentsList },
    stickers: { size: 0 },
    mentions: { users: { has: () => false }, everyone: false },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    reference: undefined,
    ...overrides,
  }
}

// ─── 測試 ────────────────────────────────────────────────────────

describe('DiscordChannel', () => {
  let channel: InstanceType<typeof DiscordChannel>
  let receivedMessages: UnifiedMessage[]

  beforeEach(async () => {
    receivedMessages = []
    mockChannelsFetch.mockClear()
    channel = new DiscordChannel(createTestConfig({
      DISCORD_TOKEN: 'test-token',
      DISCORD_CLIENT_ID: 'test-client-id',
      discordEnabled: true,
      DISCORD_GROUP_ID_MODE: 'guild',
      LINE_CHANNEL_SECRET: 'test-secret',
      LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
      lineEnabled: true,
      LINE_WEBHOOK_PORT: 3000,
      embeddingEnabled: true,
    }))
    channel.onMessage = msg => receivedMessages.push(msg)
    await channel.start()
  })

  describe('name', () => {
    test('name 為 "discord"', () => {
      expect(channel.name).toBe('discord')
    })
  })

  describe('start / stop', () => {
    test('start 成功後可正常接收訊息', () => {
      emitMessageCreate(createMockMessage())
      expect(receivedMessages).toHaveLength(1)
    })

    test('stop 不 throw', async () => {
      await expect(channel.stop()).resolves.toBeUndefined()
    })
  })

  describe('MessageCreate 事件處理', () => {
    test('正常訊息轉換為 UnifiedMessage', () => {
      const mockMsg = createMockMessage({
        id: 'msg-001',
        content: 'Hello Discord',
        author: { id: 'user-1', displayName: 'Alice', bot: false },
        guild: { id: 'guild-A' },
        channel: {
          id: 'ch-1',
          send: mock(async () => {}),
          messages: { fetch: mock(async () => ({ react: mock(async () => {}) })) },
        },
        createdAt: new Date('2026-02-01T12:00:00Z'),
      })

      emitMessageCreate(mockMsg)

      expect(receivedMessages).toHaveLength(1)
      const unified = receivedMessages[0]
      expect(unified.id).toBe('msg-001')
      expect(unified.content).toBe('Hello Discord')
      expect(unified.userId).toBe('user-1')
      expect(unified.userName).toBe('Alice')
      expect(unified.platform).toBe('discord')
      expect(unified.isBot).toBe(false)
      expect(unified.timestamp).toEqual(new Date('2026-02-01T12:00:00Z'))
    })

    test('bot 訊息被過濾（isBot === true → 跳過）', () => {
      emitMessageCreate(
        createMockMessage({
          author: { id: 'bot-1', displayName: 'Bot', bot: true },
        }),
      )
      expect(receivedMessages).toHaveLength(0)
    })

    test('DM 訊息被過濾（guild 為 null）', () => {
      emitMessageCreate(createMockMessage({ guild: null }))
      expect(receivedMessages).toHaveLength(0)
    })

    test('空 content + 有 attachment → content 為 "[圖片]"', () => {
      emitMessageCreate(
        createMockMessage({
          content: '',
          attachments: { size: 1, values: () => [{ url: 'https://example.com/image.png', contentType: 'image/png' }] },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0].content).toBe('[圖片]')
    })

    test('空 content + 有 sticker → content 為 "[貼圖]"', () => {
      emitMessageCreate(
        createMockMessage({
          content: '',
          stickers: { size: 1 },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0].content).toBe('[貼圖]')
    })

    test('空 content + 無 attachment + 無 sticker → 跳過', () => {
      emitMessageCreate(
        createMockMessage({
          content: '',
          attachments: { size: 0, values: () => [] },
          stickers: { size: 0 },
        }),
      )
      expect(receivedMessages).toHaveLength(0)
    })

    test('attachment 優先於 sticker（同時存在時）', () => {
      emitMessageCreate(
        createMockMessage({
          content: '',
          attachments: { size: 1, values: () => [{ url: 'https://example.com/image.jpg', contentType: 'image/jpeg' }] },
          stickers: { size: 1 },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0].content).toBe('[圖片]')
    })

    test('raw 欄位包含原始 Message 物件', () => {
      const mockMsg = createMockMessage()
      emitMessageCreate(mockMsg)
      expect(receivedMessages[0].raw).toBe(mockMsg)
    })

    test('reply 메시지 → replyToExternalId 설정됨', () => {
      emitMessageCreate(createMockMessage({
        reference: { messageId: 'reply-target-123' },
      }))
      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0].replyToExternalId).toBe('reply-target-123')
    })

    test('일반 메시지 → replyToExternalId undefined', () => {
      emitMessageCreate(createMockMessage({ reference: undefined }))
      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0].replyToExternalId).toBeUndefined()
    })

    test('純圖片訊息（無文字）→ content = "[圖片]" + images 有值', () => {
      emitMessageCreate(
        createMockMessage({
          content: '',
          attachments: {
            size: 1,
            values: () => [
              { url: 'https://cdn.discord.com/image1.png', contentType: 'image/png' },
            ],
          },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      const msg = receivedMessages[0]
      expect(msg.content).toBe('[圖片]')
      expect(msg.images).toBeDefined()
      expect(msg.images).toHaveLength(1)
      expect(msg.images![0].url).toBe('https://cdn.discord.com/image1.png')
      expect(msg.images![0].contentType).toBe('image/png')
    })

    test('文字 + 圖片訊息 → content 保留原文字 + images 有值', () => {
      emitMessageCreate(
        createMockMessage({
          content: '看看這張圖',
          attachments: {
            size: 1,
            values: () => [
              { url: 'https://cdn.discord.com/photo.jpg', contentType: 'image/jpeg' },
            ],
          },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      const msg = receivedMessages[0]
      expect(msg.content).toBe('看看這張圖')
      expect(msg.images).toBeDefined()
      expect(msg.images).toHaveLength(1)
      expect(msg.images![0].url).toBe('https://cdn.discord.com/photo.jpg')
      expect(msg.images![0].contentType).toBe('image/jpeg')
    })

    test('多張圖片 → images 包含所有圖片', () => {
      emitMessageCreate(
        createMockMessage({
          content: '多張圖片',
          attachments: {
            size: 2,
            values: () => [
              { url: 'https://cdn.discord.com/img1.png', contentType: 'image/png' },
              { url: 'https://cdn.discord.com/img2.gif', contentType: 'image/gif' },
            ],
          },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      const msg = receivedMessages[0]
      expect(msg.images).toBeDefined()
      expect(msg.images).toHaveLength(2)
      expect(msg.images![0].url).toBe('https://cdn.discord.com/img1.png')
      expect(msg.images![1].url).toBe('https://cdn.discord.com/img2.gif')
    })

    test('非圖片附件（PDF）→ images 為 undefined', () => {
      emitMessageCreate(
        createMockMessage({
          content: '文件',
          attachments: {
            size: 1,
            values: () => [
              { url: 'https://cdn.discord.com/document.pdf', contentType: 'application/pdf' },
            ],
          },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      const msg = receivedMessages[0]
      expect(msg.content).toBe('文件')
      expect(msg.images).toBeUndefined()
    })

    test('混合附件（圖片 + PDF）→ images 只包含圖片', () => {
      emitMessageCreate(
        createMockMessage({
          content: '圖片和文件',
          attachments: {
            size: 2,
            values: () => [
              { url: 'https://cdn.discord.com/image.png', contentType: 'image/png' },
              { url: 'https://cdn.discord.com/doc.pdf', contentType: 'application/pdf' },
            ],
          },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      const msg = receivedMessages[0]
      expect(msg.images).toBeDefined()
      expect(msg.images).toHaveLength(1)
      expect(msg.images![0].url).toBe('https://cdn.discord.com/image.png')
    })

    test('contentType 為 null → 不納入 images', () => {
      emitMessageCreate(
        createMockMessage({
          content: '未知類型',
          attachments: {
            size: 1,
            values: () => [
              { url: 'https://cdn.discord.com/unknown', contentType: null },
            ],
          },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      const msg = receivedMessages[0]
      expect(msg.images).toBeUndefined()
    })

    test('純文字訊息（無附件）→ images 為 undefined', () => {
      emitMessageCreate(
        createMockMessage({
          content: '只有文字',
          attachments: { size: 0, values: () => [] },
        }),
      )
      expect(receivedMessages).toHaveLength(1)
      const msg = receivedMessages[0]
      expect(msg.content).toBe('只有文字')
      expect(msg.images).toBeUndefined()
    })
  })  // describe('MessageCreate 事件處理') end

  describe('groupIdMode', () => {
    test('guild mode：groupId 為 guild.id', () => {
      emitMessageCreate(
        createMockMessage({
          guild: { id: 'guild-AAA' },
          channel: {
            id: 'ch-BBB',
            send: mock(async () => {}),
            messages: { fetch: mock(async () => ({ react: mock(async () => {}) })) },
          },
        }),
      )
      expect(receivedMessages[0].groupId).toBe('guild-AAA')
    })

    test('channel mode：groupId 為 channel.id', async () => {
      const tempChannel = new DiscordChannel(
        createTestConfig({
          DISCORD_TOKEN: 'test-token',
          DISCORD_CLIENT_ID: 'test-client-id',
          discordEnabled: true,
          DISCORD_GROUP_ID_MODE: 'channel',
        }),
      )
      const channelMessages: UnifiedMessage[] = []
      tempChannel.onMessage = msg => channelMessages.push(msg)
      await tempChannel.start()

      emitMessageCreate(
        createMockMessage({
          guild: { id: 'guild-AAA' },
          channel: {
            id: 'ch-BBB',
            send: mock(async () => {}),
            messages: { fetch: mock(async () => ({ react: mock(async () => {}) })) },
          },
        }),
      )
      expect(channelMessages[0].groupId).toBe('ch-BBB')
    })
  })

  describe('isMention', () => {
    test('被 @ mention 時 isMention 為 true', () => {
      emitMessageCreate(
        createMockMessage({
          mentions: {
            users: { has: (id: string) => id === 'bot-user-id' },
            everyone: false,
          },
        }),
      )
      expect(receivedMessages[0].isMention).toBe(true)
    })

    test('@everyone 時 isMention 為 true', () => {
      emitMessageCreate(
        createMockMessage({
          mentions: { users: { has: () => false }, everyone: true },
        }),
      )
      expect(receivedMessages[0].isMention).toBe(true)
    })

    test('未被 mention 時 isMention 為 false', () => {
      emitMessageCreate(
        createMockMessage({
          mentions: { users: { has: () => false }, everyone: false },
        }),
      )
      expect(receivedMessages[0].isMention).toBe(false)
    })
  })

  describe('sendMessage', () => {
    test('guild mode：透過 activeChannels 發送訊息', async () => {
      const mockChannel = createMockMessage().channel
      // 先觸發一條訊息讓 channel 記錄 activeChannel
      emitMessageCreate(
        createMockMessage({
          guild: { id: 'guild-X' },
          channel: mockChannel,
        }),
      )

      await channel.sendMessage('guild-X', '回覆訊息')
      expect(mockChannel.send).toHaveBeenCalledWith('回覆訊息')
    })

    test('guild mode：未知 groupId 不 throw', async () => {
      await expect(
        channel.sendMessage('unknown-guild', 'test'),
      ).resolves.toBeUndefined()
    })

    test('channel mode：透過 channels.fetch 發送訊息', async () => {
      const tempChannel = new DiscordChannel(
        createTestConfig({
          DISCORD_TOKEN: 'test-token',
          DISCORD_CLIENT_ID: 'test-client-id',
          discordEnabled: true,
          DISCORD_GROUP_ID_MODE: 'channel',
        }),
      )
      await tempChannel.start()

      const mockSend = mock(async () => {})
      mockChannelsFetch.mockResolvedValueOnce({
        type: 0, // ChannelType.GuildText
        send: mockSend,
      } as unknown)

      await tempChannel.sendMessage('ch-123', '頻道訊息')
      expect(mockChannelsFetch).toHaveBeenCalledWith('ch-123')
      expect(mockSend).toHaveBeenCalledWith('頻道訊息')
    })

    test('content 超過 2000 字元被截斷並加上省略號', async () => {
      const mockChannel = createMockMessage().channel
      emitMessageCreate(
        createMockMessage({
          guild: { id: 'guild-truncate' },
          channel: mockChannel,
        }),
      )

      const longContent = 'A'.repeat(3000)
      await channel.sendMessage('guild-truncate', longContent)

      const sentContent = (mockChannel.send as Mock<(c: string) => Promise<void>>).mock.calls[0][0]
      expect(sentContent).toHaveLength(2000)
      expect(sentContent).toBe(`${'A'.repeat(1997)}...`)
    })

    test('content 剛好 2000 字元不截斷', async () => {
      const mockChannel = createMockMessage().channel
      emitMessageCreate(
        createMockMessage({
          guild: { id: 'guild-exact' },
          channel: mockChannel,
        }),
      )

      const exactContent = 'B'.repeat(2000)
      await channel.sendMessage('guild-exact', exactContent)

      const sentContent = (mockChannel.send as Mock<(c: string) => Promise<void>>).mock.calls[0][0]
      expect(sentContent).toHaveLength(2000)
    })
  })

  describe('sendReaction', () => {
    test('guild mode：對 activeChannel 中的訊息加上反應', async () => {
      const mockReact = mock(async () => {})
      const mockFetch = mock(async () => ({ react: mockReact }))
      const mockChannel = {
        id: 'ch-react',
        send: mock(async () => {}),
        messages: { fetch: mockFetch },
      }

      emitMessageCreate(
        createMockMessage({
          guild: { id: 'guild-react' },
          channel: mockChannel,
        }),
      )

      await channel.sendReaction('guild-react', 'msg-target', '👍')

      expect(mockFetch).toHaveBeenCalledWith('msg-target')
      expect(mockReact).toHaveBeenCalledWith('👍')
    })

    test('channel mode：透過 channels.fetch 加上反應', async () => {
      const tempChannel = new DiscordChannel(
        createTestConfig({
          DISCORD_TOKEN: 'test-token',
          DISCORD_CLIENT_ID: 'test-client-id',
          discordEnabled: true,
          DISCORD_GROUP_ID_MODE: 'channel',
        }),
      )
      await tempChannel.start()

      const mockReact = mock(async () => {})
      const mockMsgFetch = mock(async () => ({ react: mockReact }))
      mockChannelsFetch.mockResolvedValueOnce({
        type: 0, // ChannelType.GuildText
        messages: { fetch: mockMsgFetch },
      } as unknown)

      await tempChannel.sendReaction('ch-react', 'msg-target', '❤️')
      expect(mockChannelsFetch).toHaveBeenCalledWith('ch-react')
      expect(mockMsgFetch).toHaveBeenCalledWith('msg-target')
      expect(mockReact).toHaveBeenCalledWith('❤️')
    })

    test('guild mode：未知 groupId 不 throw', async () => {
      await expect(
        channel.sendReaction('unknown-guild', 'msg-1', '👍'),
      ).resolves.toBeUndefined()
    })
  })
})
