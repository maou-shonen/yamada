import type { LanguageModelV2 } from '@ai-sdk/provider'
import { afterEach, describe, expect, it } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import {
  createEmbeddingModelFromId,
  createModelFromId,
  parseModelId,
  parseModelList,
} from './provider.ts'

const PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
] as const

afterEach(() => {
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key]
})

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

  it('解析 unknown/model 仍保留 provider 與 modelName', () => {
    const result = parseModelId('unknown/model')
    expect(result).toEqual({ provider: 'unknown', modelName: 'model' })
  })

  it('無斜線 → 拋出格式錯誤', () => {
    expect(() => parseModelId('gpt-4o')).toThrow('無效的 model ID 格式')
  })

  it('provider/ 無 model 名稱 → 拋出錯誤', () => {
    expect(() => parseModelId('openai/')).toThrow('model 名稱不可為空')
  })

  it('/model provider 為空 → 拋出錯誤', () => {
    expect(() => parseModelId('/gpt-4o')).toThrow('provider 前綴不可為空')
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
})

describe('createModelFromId', () => {
  it('openai/gpt-4o-mini → 回傳語言模型', () => {
    process.env.OPENAI_API_KEY = 'test'
    const config = createTestConfig()
    const model = assertModel(createModelFromId('openai/gpt-4o-mini', config))
    expect(model.modelId).toBe('gpt-4o-mini')
  })

  it('openrouter/anthropic/claude-sonnet-4-20250514 → 回傳語言模型', () => {
    process.env.OPENROUTER_API_KEY = 'test'
    const config = createTestConfig()
    const model = assertModel(createModelFromId('openrouter/anthropic/claude-sonnet-4-20250514', config))
    expect(model.modelId).toBe('anthropic/claude-sonnet-4-20250514')
  })
})

describe('createEmbeddingModelFromId', () => {
  it('openai/text-embedding-3-small → 回傳 embedding 模型', () => {
    process.env.OPENAI_API_KEY = 'test'
    const config = createTestConfig()
    const model = createEmbeddingModelFromId('openai/text-embedding-3-small', config)
    expect(model).toBeDefined()
    expect(typeof model).toBe('object')
    expect((model as any).modelId).toBe('text-embedding-3-small')
  })
})
