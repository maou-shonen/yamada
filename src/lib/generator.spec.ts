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
    const createModelMock = mock((config: Config) => ({ model: config.AI_MODEL }))
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

  test('使用 config 中的 aiModel 建立模型', async () => {
    const config = createTestConfig({ AI_PROVIDER: 'openai', AI_MODEL: 'gpt-4o', OBSERVER_MODEL: 'gpt-4o-mini' })
    const messages = [{ role: 'user' as const, content: '你好' }]
    const { deps, createModelMock } = createFakeDeps()

    await generateReply(messages, config, deps)

    expect(createModelMock).toHaveBeenCalledWith(config)
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

  test('未設定 API key 時拋出錯誤', async () => {
    const config = createTestConfig()
    const messages = [{ role: 'user' as const, content: '你好' }]

    await expect(generateReply(messages, config)).rejects.toThrow()
  })
})
