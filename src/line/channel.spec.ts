import type { Config } from '../config/index.ts'
import type { UnifiedMessage } from '../types.ts'
import crypto from 'node:crypto'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { LineChannel } from './channel.ts'
import { ReplyTokenPool } from './reply-token-pool.ts'

// ── Helper: 產生有效的 LINE webhook 簽名 ──────────

function generateSignature(body: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64')
}

// ── Helper: 發送 webhook request ──────────────────

async function sendWebhook(
  port: number,
  body: object,
  secret: string,
  options?: { signature?: string, method?: string, path?: string },
): Promise<Response> {
  const bodyStr = JSON.stringify(body)
  const signature
    = options?.signature ?? generateSignature(bodyStr, secret)

  return fetch(
    `http://localhost:${port}${options?.path ?? '/webhook/line'}`,
    {
      method: options?.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': signature,
      },
      body: bodyStr,
    },
  )
}

// ── Helper: 建立群組訊息事件 ──────────────────────

function createGroupMessageEvent(overrides?: {
  text?: string
  groupId?: string
  userId?: string
  messageType?: string
  messageId?: string
  replyToken?: string
  mention?: { mentionees: Array<{ type: string, userId?: string }> }
}) {
  return {
    type: 'message',
    replyToken: overrides?.replyToken ?? 'test-reply-token',
    source: {
      type: 'group',
      groupId: overrides?.groupId ?? 'Cgroup123',
      userId: overrides?.userId ?? 'Uuser456',
    },
    message: {
      type: overrides?.messageType ?? 'text',
      id: overrides?.messageId ?? 'msg-001',
      text: overrides?.text ?? 'Hello',
      ...(overrides?.mention ? { mention: overrides.mention } : {}),
    },
    timestamp: Date.now(),
  }
}

// ── Helper: 建立 DM 事件 ─────────────────────────

function createDmEvent(text = 'Hello') {
  return {
    type: 'message',
    replyToken: 'dm-reply-token',
    source: {
      type: 'user',
      userId: 'Uuser789',
    },
    message: {
      type: 'text',
      id: 'dm-msg-001',
      text,
    },
    timestamp: Date.now(),
  }
}

// ── Mock 設定 ─────────────────────────────────────

/** 建立 mock MessagingApiClient 並注入到 channel */
function createMockClient() {
  return {
    replyMessage: mock(() => Promise.resolve({})),
    pushMessage: mock(() => Promise.resolve({})),
    getGroupMemberProfile: mock(() =>
      Promise.resolve({ displayName: 'TestUser', userId: 'Uuser456' }),
    ),
  }
}

function injectMockClient(
  channel: LineChannel,
  mockClient: ReturnType<typeof createMockClient>,
) {
  // 透過 prototype hack 注入 mock client
  (channel as unknown as { client: unknown }).client = mockClient
}

// ── 測試 ─────────────────────────────────────────

describe('LineChannel', () => {
  let channel: LineChannel
  let config: Config

  beforeEach(() => {
    config = createTestConfig({
      DISCORD_TOKEN: 'test-discord-token',
      DISCORD_CLIENT_ID: 'test-client-id',
      discordEnabled: true,
      DISCORD_GROUP_ID_MODE: 'guild',
      LINE_CHANNEL_SECRET: 'test-channel-secret',
      LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
      lineEnabled: true,
      LINE_WEBHOOK_PORT: 0,
      embeddingEnabled: true,
    })
    channel = new LineChannel(config)
  })

  afterEach(async () => {
    await channel.stop()
  })

  describe('start / stop 生命週期', () => {
    test('start() 啟動 webhook server', async () => {
      await channel.start()

      // 驗證 server 已啟動（可接收 request）
      const port = (channel as unknown as { server: { port: number } }).server.port
      const res = await fetch(`http://localhost:${port}/webhook/line`, {
        method: 'GET',
      })
      // GET 應回 404（僅接受 POST）
      expect(res.status).toBe(404)
    })

    test('stop() 關閉 webhook server', async () => {
      await channel.start()

      await channel.stop()

      // server 已停止，client 也清除
      expect(
        (channel as unknown as { server: null }).server,
      ).toBeNull()
      expect(
        (channel as unknown as { client: null }).client,
      ).toBeNull()
    })

    test('stop() 重複呼叫不會 throw', async () => {
      await channel.start()
      await channel.stop()
      await channel.stop() // 第二次不應報錯
    })
  })

  describe('Webhook 簽名驗證', () => {
    test('有效簽名 → 200 OK', async () => {
      await channel.start()
      const port = (channel as unknown as { server: { port: number } }).server.port

      const res = await sendWebhook(
        port,
        { events: [] },
        config.LINE_CHANNEL_SECRET!,
      )
      expect(res.status).toBe(200)
    })

    test('無效簽名 → 401 Unauthorized', async () => {
      await channel.start()
      const port = (channel as unknown as { server: { port: number } }).server.port

      const res = await sendWebhook(
        port,
        { events: [] },
        config.LINE_CHANNEL_SECRET!,
        { signature: 'invalid-signature' },
      )
      expect(res.status).toBe(401)
    })

    test('缺少簽名 → 401 Unauthorized', async () => {
      await channel.start()
      const port = (channel as unknown as { server: { port: number } }).server.port

      const bodyStr = JSON.stringify({ events: [] })
      const res = await fetch(`http://localhost:${port}/webhook/line`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr,
      })
      expect(res.status).toBe(401)
    })

    test('非 POST 方法 → 404', async () => {
      await channel.start()
      const port = (channel as unknown as { server: { port: number } }).server.port

      const res = await fetch(`http://localhost:${port}/webhook/line`, {
        method: 'GET',
      })
      expect(res.status).toBe(404)
    })

    test('非 /webhook/line 路徑 → 404', async () => {
      await channel.start()
      const port = (channel as unknown as { server: { port: number } }).server.port

      const res = await sendWebhook(
        port,
        { events: [] },
        config.LINE_CHANNEL_SECRET!,
        { path: '/other-path' },
      )
      expect(res.status).toBe(404)
    })
  })

  describe('群組訊息處理', () => {
    test('群組文字訊息 → 觸發 onMessage 並轉換為 UnifiedMessage', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)

      const port = (channel as unknown as { server: { port: number } }).server.port

      const received: UnifiedMessage[] = []
      channel.onMessage = msg => received.push(msg)

      const event = createGroupMessageEvent({ text: '測試訊息' })
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)

      // 等待非同步事件處理完成
      await new Promise(r => setTimeout(r, 100))

      expect(received.length).toBe(1)
      expect(received[0].content).toBe('測試訊息')
      expect(received[0].groupId).toBe('Cgroup123')
      expect(received[0].userId).toBe('Uuser456')
      expect(received[0].userName).toBe('TestUser')
      expect(received[0].platform).toBe('line')
      expect(received[0].isBot).toBe(false)
      expect(received[0].id).toBe('msg-001')
    })

    test('圖片訊息 → content 為 [圖片]', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      const received: UnifiedMessage[] = []
      channel.onMessage = msg => received.push(msg)

      const event = createGroupMessageEvent({ messageType: 'image' })
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      await new Promise(r => setTimeout(r, 100))

      expect(received[0].content).toBe('[圖片]')
    })

    test('貼圖訊息 → content 為 [貼圖]', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      const received: UnifiedMessage[] = []
      channel.onMessage = msg => received.push(msg)

      const event = createGroupMessageEvent({ messageType: 'sticker' })
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      await new Promise(r => setTimeout(r, 100))

      expect(received[0].content).toBe('[貼圖]')
    })

    test('影片訊息 → content 為 [影片]', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      const received: UnifiedMessage[] = []
      channel.onMessage = msg => received.push(msg)

      const event = createGroupMessageEvent({ messageType: 'video' })
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      await new Promise(r => setTimeout(r, 100))

      expect(received[0].content).toBe('[影片]')
    })

    test('getGroupMemberProfile 失敗 → fallback 到 userId', async () => {
      await channel.start()
      const mockClient = createMockClient()
      mockClient.getGroupMemberProfile = mock(() =>
        Promise.reject(new Error('Profile not found')),
      )
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      const received: UnifiedMessage[] = []
      channel.onMessage = msg => received.push(msg)

      const event = createGroupMessageEvent()
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      await new Promise(r => setTimeout(r, 100))

      expect(received[0].userName).toBe('Uuser456')
    })

    test('mention 訊息 → isMention 為 true', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      const received: UnifiedMessage[] = []
      channel.onMessage = msg => received.push(msg)

      const event = createGroupMessageEvent({
        mention: {
          mentionees: [{ type: 'user', userId: 'Ubot123' }],
        },
      })
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      await new Promise(r => setTimeout(r, 100))

      expect(received[0].isMention).toBe(true)
    })

    test('無 mention 訊息 → isMention 為 false', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      const received: UnifiedMessage[] = []
      channel.onMessage = msg => received.push(msg)

      const event = createGroupMessageEvent()
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      await new Promise(r => setTimeout(r, 100))

      expect(received[0].isMention).toBe(false)
    })
  })

  describe('DM 私訊處理', () => {
    test('DM 事件 → 回覆「暫不支援私訊功能」', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      const received: UnifiedMessage[] = []
      channel.onMessage = msg => received.push(msg)

      const event = createDmEvent()
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      await new Promise(r => setTimeout(r, 100))

      // DM 不應觸發 onMessage
      expect(received.length).toBe(0)

      // 應呼叫 replyMessage
      expect(mockClient.replyMessage).toHaveBeenCalledTimes(1)
      expect(mockClient.replyMessage).toHaveBeenCalledWith({
        replyToken: 'dm-reply-token',
        messages: [{ type: 'text', text: '暫不支援私訊功能' }],
      })
    })
  })

  describe('sendMessage — reply/push fallback', () => {
    test('有新鮮 replyToken → 使用 replyMessage', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)

      // 透過 pool 存放新鮮的 token
      const pool = (channel as unknown as { pool: ReplyTokenPool }).pool
      pool.store('Cgroup123', 'fresh-token')

      await channel.sendMessage('Cgroup123', '回覆內容')

      expect(mockClient.replyMessage).toHaveBeenCalledTimes(1)
      expect(mockClient.replyMessage).toHaveBeenCalledWith({
        replyToken: 'fresh-token',
        messages: [{ type: 'text', text: '回覆內容' }],
      })
      expect(mockClient.pushMessage).not.toHaveBeenCalled()

      // 使用後 token 應被 pool 移除（claim 返回 null）
      expect(pool.claim('Cgroup123')).toBeNull()
    })

    test('replyToken 過期 → 直接使用 pushMessage', async () => {
      // 建立可控時間的 pool 並注入 channel
      let nowMs = Date.now()
      const FRESHNESS_MS = 30_000 // 此測試獨立控制 freshness 邊界，不依賴 config
      const customPool = new ReplyTokenPool(
        FRESHNESS_MS,
        () => nowMs,
      )
      const testChannel = new LineChannel(config, { pool: customPool })
      await testChannel.start()
      const mockClient = createMockClient()
      injectMockClient(testChannel, mockClient)

      // 存放 token（此時時間為 nowMs）
      customPool.store('Cgroup123', 'stale-token')

      // 模擬時間快進（超過 freshness），讓 token 過期
      nowMs += FRESHNESS_MS + 1_000

      await testChannel.sendMessage('Cgroup123', '推送內容')
      await testChannel.stop()

      expect(mockClient.replyMessage).not.toHaveBeenCalled()
      expect(mockClient.pushMessage).toHaveBeenCalledTimes(1)
      expect(mockClient.pushMessage).toHaveBeenCalledWith({
        to: 'Cgroup123',
        messages: [{ type: 'text', text: '推送內容' }],
      })
    })

    test('replyMessage 失敗 → fallback 到 pushMessage', async () => {
      await channel.start()
      const mockClient = createMockClient()
      mockClient.replyMessage = mock(() =>
        Promise.reject(new Error('Invalid reply token')),
      )
      injectMockClient(channel, mockClient)

      // 透過 pool 存放新鮮的 token
      const pool = (channel as unknown as { pool: ReplyTokenPool }).pool
      pool.store('Cgroup123', 'bad-token')

      await channel.sendMessage('Cgroup123', '測試 fallback')

      // 先嘗試 reply，失敗後 fallback 到 push
      expect(mockClient.replyMessage).toHaveBeenCalledTimes(1)
      expect(mockClient.pushMessage).toHaveBeenCalledTimes(1)
      expect(mockClient.pushMessage).toHaveBeenCalledWith({
        to: 'Cgroup123',
        messages: [{ type: 'text', text: '測試 fallback' }],
      })
    })

    test('無快取 replyToken → 直接使用 pushMessage', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)

      await channel.sendMessage('Cgroup123', '無 token')

      expect(mockClient.replyMessage).not.toHaveBeenCalled()
      expect(mockClient.pushMessage).toHaveBeenCalledTimes(1)
    })

    test('content 超過 5000 chars → 截斷', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)

      const longContent = 'A'.repeat(6000)
      await channel.sendMessage('Cgroup123', longContent)

      const calledWith = (mockClient.pushMessage as ReturnType<typeof mock>)
        .mock
        .calls[0] as [{ to: string, messages: Array<{ text: string }> }]
      expect(calledWith[0].messages[0].text.length).toBe(5000)
    })

    test('client 未初始化 → throw Error', async () => {
      // 不呼叫 start()，client 為 null
      expect(channel.sendMessage('Cgroup123', 'test')).rejects.toThrow(
        '尚未初始化',
      )
    })
  })

  describe('sendReaction', () => {
    test('不 throw，僅記錄 log', async () => {
      await channel.start()

      // 不應 throw
      await channel.sendReaction('Cgroup123', 'msg-001', '👍')
    })
  })

  describe('replyToken 快取', () => {
    test('webhook 事件更新 replyToken 快取', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      channel.onMessage = () => {}

      const event = createGroupMessageEvent({
        replyToken: 'cached-token-123',
        groupId: 'CgroupABC',
      })
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      await new Promise(r => setTimeout(r, 100))

      // 透過 pool 驗證 token 已被儲存
      const pool = (channel as unknown as { pool: ReplyTokenPool }).pool
      const token = pool.claim('CgroupABC')
      expect(token).toBe('cached-token-123')
    })
  })

  describe('name 屬性', () => {
    test('name 為 "line"', () => {
      expect(channel.name).toBe('line')
    })
  })

  describe('非 message 事件', () => {
    test('follow 事件 → 不處理', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      const received: UnifiedMessage[] = []
      channel.onMessage = msg => received.push(msg)

      const event = {
        type: 'follow',
        replyToken: 'follow-token',
        source: { type: 'user', userId: 'Ufollow' },
        timestamp: Date.now(),
      }
      await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      await new Promise(r => setTimeout(r, 100))

      expect(received.length).toBe(0)
    })
  })

  describe('ReplyTokenPool 整合', () => {
    test('多個 webhook 事件儲存多個 token', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)
      const port = (channel as unknown as { server: { port: number } }).server.port

      const pool = (channel as unknown as { pool: ReplyTokenPool }).pool

      // 傳送 3 個不同 replyToken 的 webhook 事件到同一群組
      for (let i = 1; i <= 3; i++) {
        const event = createGroupMessageEvent({
          replyToken: `token-${i}`,
          groupId: 'CgroupABC',
          messageId: `msg-00${i}`,
        })
        await sendWebhook(port, { events: [event] }, config.LINE_CHANNEL_SECRET!)
      }
      await new Promise(r => setTimeout(r, 100))

      // pool 應按 FIFO 順序累積 3 個 token（而非覆蓋）
      expect(pool.claim('CgroupABC')).toBe('token-1')
      expect(pool.claim('CgroupABC')).toBe('token-2')
      expect(pool.claim('CgroupABC')).toBe('token-3')
      expect(pool.claim('CgroupABC')).toBeNull()
    })

    test('多次 sendMessage 使用不同 token', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)

      const pool = (channel as unknown as { pool: ReplyTokenPool }).pool

      // 預先存放 2 個不同的 token
      pool.store('Cgroup123', 'token-A')
      pool.store('Cgroup123', 'token-B')

      await channel.sendMessage('Cgroup123', '第一次回覆')
      await channel.sendMessage('Cgroup123', '第二次回覆')

      // 兩次都應使用 replyMessage，不使用 pushMessage
      expect(mockClient.replyMessage).toHaveBeenCalledTimes(2)
      expect(mockClient.pushMessage).not.toHaveBeenCalled()

      // 驗證兩次使用了不同的 token（FIFO 順序）
      const calls = (mockClient.replyMessage as ReturnType<typeof mock>).mock.calls as Array<[{ replyToken: string, messages: unknown[] }]>
      expect(calls[0][0].replyToken).toBe('token-A')
      expect(calls[1][0].replyToken).toBe('token-B')
    })

    test('pool 耗盡後 fallback', async () => {
      await channel.start()
      const mockClient = createMockClient()
      injectMockClient(channel, mockClient)

      const pool = (channel as unknown as { pool: ReplyTokenPool }).pool

      // 只存放 1 個 token
      pool.store('Cgroup123', 'only-token')

      // 第一次 sendMessage 應使用 replyMessage（有 token）
      await channel.sendMessage('Cgroup123', '第一次')
      // 第二次 sendMessage pool 已空，應 fallback 到 pushMessage
      await channel.sendMessage('Cgroup123', '第二次')

      expect(mockClient.replyMessage).toHaveBeenCalledTimes(1)
      expect(mockClient.pushMessage).toHaveBeenCalledTimes(1)
    })

    test('stop() 清空 pool', async () => {
      await channel.start()
      const pool = (channel as unknown as { pool: ReplyTokenPool }).pool

      // 存放多個 token
      pool.store('Cgroup123', 'before-stop-token')
      pool.store('CgroupXYZ', 'another-token')

      // stop() 應清空 pool
      await channel.stop()

      // pool 已被清空，claim 應返回 null
      expect(pool.claim('Cgroup123')).toBeNull()
      expect(pool.claim('CgroupXYZ')).toBeNull()
    })
  })
})
