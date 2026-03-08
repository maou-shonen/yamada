import type { Config } from '../config/index.ts'
import type { GeneratorDeps } from './generator'

import { describe, expect, mock, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { generateReply } from './generator'

/**
 * 建立假的 generateText 回傳值。
 * WHY helper：AI SDK 的回傳結構（steps > toolCalls）較深，
 * 每個測試都手寫太冗長且容易出錯。
 */
function fakeGenerateTextResult(toolCalls: Array<{ toolName: string, input: Record<string, unknown> }>, usage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
}) {
  return {
    text: '',
    usage,
    steps: [{
      toolCalls: toolCalls.map(tc => ({ ...tc, dynamic: false })),
    }],
  }
}

describe('generateReply', () => {
  function createFakeDeps(toolCalls: Array<{ toolName: string, input: Record<string, unknown> }> = [
    { toolName: 'reply', input: { content: '你好，這是測試回覆' } },
  ]) {
    const createModelMock = mock((modelId: string, _config: Config) => ({ modelId }))
    const generateTextMock = mock(async () => fakeGenerateTextResult(toolCalls))

    const deps: GeneratorDeps = {
      createModel: createModelMock as unknown as GeneratorDeps['createModel'],
      generateText: generateTextMock as unknown as GeneratorDeps['generateText'],
    }

    return {
      deps,
      createModelMock,
      generateTextMock,
    }
  }

  test('reply tool call → 回傳 reply action', async () => {
    const config = createTestConfig()
    const messages = [{ role: 'user' as const, content: '你好' }]
    const { deps } = createFakeDeps()

    const result = await generateReply(messages, config, deps)

    expect(result.actions).toEqual([
      { type: 'reply', content: '你好，這是測試回覆' },
    ])
  })

  test('skip tool call → 回傳 skip action 附帶 reason', async () => {
    const config = createTestConfig()
    const messages = [{ role: 'user' as const, content: '你好' }]
    const { deps } = createFakeDeps([
      { toolName: 'skip', input: { reason: '跟我無關' } },
    ])

    const result = await generateReply(messages, config, deps)

    expect(result.actions).toEqual([
      { type: 'skip', reason: '跟我無關' },
    ])
  })

  test('reaction tool call → 回傳 reaction action 附帶 emoji', async () => {
    const config = createTestConfig()
    const messages = [{ role: 'user' as const, content: '你好' }]
    const { deps } = createFakeDeps([
      { toolName: 'reaction', input: { emoji: '👍' } },
    ])

    const result = await generateReply(messages, config, deps)

    expect(result.actions).toEqual([
      { type: 'reaction', emoji: '👍' },
    ])
  })

  test('多個 tool calls → 回傳對應的多個 actions', async () => {
    const config = createTestConfig()
    const messages = [{ role: 'user' as const, content: '你好' }]
    const { deps } = createFakeDeps([
      { toolName: 'reaction', input: { emoji: '😂' } },
      { toolName: 'reply', input: { content: '太好笑了' } },
    ])

    const result = await generateReply(messages, config, deps)

    expect(result.actions).toEqual([
      { type: 'reaction', emoji: '😂' },
      { type: 'reply', content: '太好笑了' },
    ])
  })

  test('正確回傳 token usage', async () => {
    const config = createTestConfig()
    const messages = [{ role: 'user' as const, content: '你好' }]
    const { deps } = createFakeDeps()

    const result = await generateReply(messages, config, deps)

    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    })
  })

  test('使用 CHAT_MODEL 中的 model ID 建立模型', async () => {
    const config = createTestConfig({ CHAT_MODEL: 'openai/gpt-4o' })
    const messages = [{ role: 'user' as const, content: '你好' }]
    const { deps, createModelMock } = createFakeDeps()

    await generateReply(messages, config, deps)

    expect(createModelMock).toHaveBeenCalledWith('openai/gpt-4o', config)
  })

  test('傳入 tools 和 toolChoice: required', async () => {
    const config = createTestConfig()
    const messages = [{ role: 'user' as const, content: '你好' }]
    const { deps, generateTextMock } = createFakeDeps()

    await generateReply(messages, config, deps)

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages,
        toolChoice: 'required',
      }),
    )
    // 驗證 tools 包含 reply、reaction、skip
    const callArgs = generateTextMock.mock.calls[0] as unknown as [Record<string, unknown>]
    const tools = callArgs[0].tools as Record<string, unknown>
    expect(Object.keys(tools).sort()).toEqual(['reaction', 'reply', 'skip'])
  })

  test('visionEnabled=true 時 tools 包含 viewImage', async () => {
    const config = createTestConfig({ visionEnabled: true })
    const messages = [{ role: 'user' as const, content: '你好' }]
    const { deps, generateTextMock } = createFakeDeps()

    await generateReply(messages, config, deps)

    const callArgs = generateTextMock.mock.calls[0] as unknown as [Record<string, unknown>]
    const tools = callArgs[0].tools as Record<string, unknown>
    expect(Object.keys(tools).sort()).toEqual(['reaction', 'reply', 'skip', 'viewImage'])
  })

  test('viewImage tool call → 回傳 viewImage action', async () => {
    const config = createTestConfig({ visionEnabled: true })
    const messages = [{ role: 'user' as const, content: '幫我看圖' }]
    const { deps } = createFakeDeps([
      { toolName: 'viewImage', input: { imageId: 5, question: '這張圖在做什麼？' } },
    ])

    const result = await generateReply(messages, config, deps)

    expect(result.actions).toEqual([
      { type: 'viewImage', imageId: 5, question: '這張圖在做什麼？' },
    ])
  })

  test('未設定 API key 時拋出錯誤', async () => {
    const config = createTestConfig()
    const messages = [{ role: 'user' as const, content: '你好' }]

    await expect(generateReply(messages, config)).rejects.toThrow()
  })

  test('fallback：第一個模型失敗時自動嘗試第二個', async () => {
    const config = createTestConfig({ CHAT_MODEL: 'openai/model-a,openai/model-b' })
    const messages = [{ role: 'user' as const, content: '你好' }]

    let callCount = 0
    const generateTextMock = mock(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('model-a failed')
      }
      return fakeGenerateTextResult([{ toolName: 'reply', input: { content: 'fallback 成功' } }])
    })
    const createModelMock = mock((modelId: string, _config: Config) => ({ modelId }))

    const deps: GeneratorDeps = {
      createModel: createModelMock as unknown as GeneratorDeps['createModel'],
      generateText: generateTextMock as unknown as GeneratorDeps['generateText'],
    }

    const result = await generateReply(messages, config, deps)

    expect(result.actions).toEqual([{ type: 'reply', content: 'fallback 成功' }])
    expect(createModelMock).toHaveBeenCalledTimes(2)
    expect(createModelMock.mock.calls[0]).toEqual(['openai/model-a', config])
    expect(createModelMock.mock.calls[1]).toEqual(['openai/model-b', config])
  })

  test('fallback：所有模型都失敗時拋出最後一個錯誤', async () => {
    const config = createTestConfig({ CHAT_MODEL: 'openai/model-a,openai/model-b' })
    const messages = [{ role: 'user' as const, content: '你好' }]

    const generateTextMock = mock(async () => {
      throw new Error('all models failed')
    })
    const createModelMock = mock((modelId: string, _config: Config) => ({ modelId }))

    const deps: GeneratorDeps = {
      createModel: createModelMock as unknown as GeneratorDeps['createModel'],
      generateText: generateTextMock as unknown as GeneratorDeps['generateText'],
    }

    await expect(generateReply(messages, config, deps)).rejects.toThrow('all models failed')
  })
})
