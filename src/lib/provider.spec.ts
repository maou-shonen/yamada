import type { LanguageModelV2 } from '@ai-sdk/provider'
import { describe, expect, it } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import {
  createEmbeddingModelFromId,
  createModelFromId,
  parseModelId,
  parseModelList,
  SUPPORTED_PROVIDERS,
} from './provider.ts'

/**
 * createModelFromId 回傳的 LanguageModel 是 union type。
 * 實際回傳值一定是物件，這裡斷言為 LanguageModelV2 以便檢查 modelId / provider。
 */
function assertModel(model: unknown): LanguageModelV2 {
  expect(typeof model).toBe('object')
  expect(model).not.toBeNull()
  return model as LanguageModelV2
}

describe('parseModelId', () => {
  it('解析 openai/gpt-4o → provider=openai, modelName=gpt-4o', () => {
    const result = parseModelId('openai/gpt-4o')
    expect(result).toEqual({ provider: 'openai', modelName: 'gpt-4o' })
  })

  it('解析 openrouter/deepseek/deepseek-v3.2 → provider=openrouter, modelName=deepseek/deepseek-v3.2', () => {
    const result = parseModelId('openrouter/deepseek/deepseek-v3.2')
    expect(result).toEqual({ provider: 'openrouter', modelName: 'deepseek/deepseek-v3.2' })
  })

  it('解析 google/gemini-2.5-pro → provider=google', () => {
    const result = parseModelId('google/gemini-2.5-pro')
    expect(result).toEqual({ provider: 'google', modelName: 'gemini-2.5-pro' })
  })

  it('無斜線 → 拋出格式錯誤', () => {
    expect(() => parseModelId('gpt-4o')).toThrow('無效的 model ID 格式')
  })

  it('不支援的 provider → 拋出錯誤', () => {
    expect(() => parseModelId('unknown/model')).toThrow('不支援的 provider')
  })

  it('provider/ 無 model 名稱 → 拋出錯誤', () => {
    expect(() => parseModelId('openai/')).toThrow('model 名稱不可為空')
  })
})

describe('parseModelList', () => {
  it('單一模型 → 回傳一個元素', () => {
    const result = parseModelList('openai/gpt-4o')
    expect(result).toEqual([{ provider: 'openai', modelName: 'gpt-4o' }])
  })

  it('逗號分隔的多模型 → 回傳多個元素（fallback）', () => {
    const result = parseModelList('openrouter/x-ai/grok-4.1-fast,openrouter/deepseek/deepseek-v3.2')
    expect(result).toEqual([
      { provider: 'openrouter', modelName: 'x-ai/grok-4.1-fast' },
      { provider: 'openrouter', modelName: 'deepseek/deepseek-v3.2' },
    ])
  })

  it('逗號前後有空白 → 正確 trim', () => {
    const result = parseModelList('openai/gpt-4o , anthropic/claude-sonnet-4-20250514')
    expect(result).toEqual([
      { provider: 'openai', modelName: 'gpt-4o' },
      { provider: 'anthropic', modelName: 'claude-sonnet-4-20250514' },
    ])
  })
})

describe('createModelFromId', () => {
  it('openai/gpt-4o-mini → 回傳 openai 語言模型', () => {
    const config = createTestConfig({ OPENAI_API_KEY: 'sk-test' })
    const model = assertModel(createModelFromId('openai/gpt-4o-mini', config))
    expect(model.modelId).toBe('gpt-4o-mini')
    expect(model.provider).toContain('openai')
  })

  it('anthropic/claude-sonnet-4-20250514 → 回傳 anthropic 語言模型', () => {
    const config = createTestConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' })
    const model = assertModel(createModelFromId('anthropic/claude-sonnet-4-20250514', config))
    expect(model.modelId).toBe('claude-sonnet-4-20250514')
    expect(model.provider).toContain('anthropic')
  })

  it('google/gemini-2.0-flash → 回傳 google 語言模型', () => {
    const config = createTestConfig({ GOOGLE_API_KEY: 'test-google-key' })
    const model = assertModel(createModelFromId('google/gemini-2.0-flash', config))
    expect(model.modelId).toBe('gemini-2.0-flash')
    expect(model.provider).toContain('google')
  })

  it('openrouter/anthropic/claude-sonnet-4-20250514 → 使用 OpenAI SDK 搭配 OpenRouter base URL', () => {
    const config = createTestConfig({ OPENROUTER_API_KEY: 'sk-or-test' })
    const model = assertModel(createModelFromId('openrouter/anthropic/claude-sonnet-4-20250514', config))
    expect(model.modelId).toBe('anthropic/claude-sonnet-4-20250514')
    expect(model.provider).toContain('openai')
  })

  it('opencode-zen/gpt-5.2 → 使用 OpenAI SDK 搭配 OpenCode Zen base URL', () => {
    const config = createTestConfig({ OPENCODE_API_KEY: 'sk-zen-test' })
    const model = assertModel(createModelFromId('opencode-zen/gpt-5.2', config))
    expect(model.modelId).toBe('gpt-5.2')
    expect(model.provider).toContain('openai')
  })

  it('per-provider BASE_URL 可覆蓋預設端點', () => {
    const config = createTestConfig({
      OPENAI_BASE_URL: 'https://custom-proxy.example.com/v1',
      OPENAI_API_KEY: 'sk-test',
    })
    const model = assertModel(createModelFromId('openai/gpt-4o-mini', config))
    expect(model.modelId).toBe('gpt-4o-mini')
  })

  it('不支援的 provider → 拋出錯誤', () => {
    const config = createTestConfig()
    expect(() => createModelFromId('nonexistent/model', config)).toThrow('不支援的 provider')
  })
})

describe('createEmbeddingModelFromId', () => {
  it('openai/text-embedding-3-small → 回傳 embedding 模型', () => {
    const config = createTestConfig({ OPENAI_API_KEY: 'sk-test' })
    const model = createEmbeddingModelFromId('openai/text-embedding-3-small', config)
    expect(model).toBeDefined()
    expect(typeof model).toBe('object')
    expect((model as any).modelId).toBe('text-embedding-3-small')
  })

  it('google/text-embedding-004 → 回傳 google embedding 模型', () => {
    const config = createTestConfig({ GOOGLE_API_KEY: 'test-google-key' })
    const model = createEmbeddingModelFromId('google/text-embedding-004', config)
    expect(model).toBeDefined()
    expect(typeof model).toBe('object')
    expect((model as any).modelId).toBe('text-embedding-004')
  })

  it('anthropic → 拋出不支援錯誤', () => {
    const config = createTestConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(() => createEmbeddingModelFromId('anthropic/any-model', config)).toThrow('Anthropic 不支援 embedding 模型')
  })
})

describe('SUPPORTED_PROVIDERS', () => {
  it('包含所有預期的 provider', () => {
    expect(SUPPORTED_PROVIDERS).toContain('openai')
    expect(SUPPORTED_PROVIDERS).toContain('anthropic')
    expect(SUPPORTED_PROVIDERS).toContain('google')
    expect(SUPPORTED_PROVIDERS).toContain('openrouter')
    expect(SUPPORTED_PROVIDERS).toContain('opencode-zen')
  })
})
