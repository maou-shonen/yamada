import type { EmbeddingModel, LanguageModel } from 'ai'
import type { Config } from '../config/index.ts'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'

// ── 支援的 provider 名稱 ──

export const SUPPORTED_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'opencode-zen',
] as const

export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number]

// ── 需要覆蓋預設 base URL 的 provider ──

const PROVIDER_BASE_URLS: Partial<Record<ProviderName, string>> = {
  'openrouter': 'https://openrouter.ai/api/v1',
  'opencode-zen': 'https://opencode.ai/zen/v1',
}

// ────────────────────────────────────────────
// Model ID 解析
// ────────────────────────────────────────────

export interface ParsedModel {
  provider: ProviderName
  modelName: string
}

/**
 * 解析 model ID 字串為 provider + modelName。
 *
 * 格式：`provider/model-name`
 * - `openai/gpt-5` → { provider: 'openai', modelName: 'gpt-5' }
 * - `openrouter/deepseek/deepseek-v3.2` → { provider: 'openrouter', modelName: 'deepseek/deepseek-v3.2' }
 */
export function parseModelId(modelId: string): ParsedModel {
  const slashIndex = modelId.indexOf('/')
  if (slashIndex === -1) {
    throw new Error(
      `無效的 model ID 格式: "${modelId}"。預期格式: provider/model-name（例如 openai/gpt-4o）`,
    )
  }

  const provider = modelId.slice(0, slashIndex)
  const modelName = modelId.slice(slashIndex + 1)

  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `不支援的 provider: "${provider}"。支援的 provider: ${SUPPORTED_PROVIDERS.join(', ')}`,
    )
  }

  if (!modelName) {
    throw new Error(
      `無效的 model ID 格式: "${modelId}"。model 名稱不可為空`,
    )
  }

  return { provider: provider as ProviderName, modelName }
}

/**
 * 解析逗號分隔的 model 列表（支援 fallback）。
 *
 * 格式：`provider/model[,provider/model,...]`
 * 例如：`openrouter/x-ai/grok-4.1-fast,openrouter/deepseek/deepseek-v3.2`
 */
export function parseModelList(models: string): ParsedModel[] {
  return models.split(',').map(m => parseModelId(m.trim()))
}

// ────────────────────────────────────────────
// createModelFromId
// ────────────────────────────────────────────

/**
 * 從 `provider/model-name` 格式的 model ID 建立語言模型。
 *
 * 根據 provider 前綴選擇 SDK，並讀取對應的 {PROVIDER}_API_KEY / {PROVIDER}_BASE_URL。
 * 若未設定 API_KEY，各 SDK 會自動讀取對應環境變數（OPENAI_API_KEY、ANTHROPIC_API_KEY 等）。
 */
export function createModelFromId(modelId: string, config: Config): LanguageModel {
  const { provider, modelName } = parseModelId(modelId)

  switch (provider) {
    case 'openai': {
      const p = createOpenAI({
        ...(config.OPENAI_BASE_URL && { baseURL: config.OPENAI_BASE_URL }),
        ...(config.OPENAI_API_KEY && { apiKey: config.OPENAI_API_KEY }),
      })
      return p(modelName)
    }

    case 'anthropic': {
      const p = createAnthropic({
        ...(config.ANTHROPIC_BASE_URL && { baseURL: config.ANTHROPIC_BASE_URL }),
        ...(config.ANTHROPIC_API_KEY && { apiKey: config.ANTHROPIC_API_KEY }),
      })
      return p(modelName)
    }

    case 'google': {
      const p = createGoogleGenerativeAI({
        ...(config.GOOGLE_BASE_URL && { baseURL: config.GOOGLE_BASE_URL }),
        ...(config.GOOGLE_API_KEY && { apiKey: config.GOOGLE_API_KEY }),
      })
      return p(modelName)
    }

    case 'openrouter': {
      const p = createOpenAI({
        baseURL: config.OPENROUTER_BASE_URL ?? PROVIDER_BASE_URLS.openrouter,
        ...(config.OPENROUTER_API_KEY && { apiKey: config.OPENROUTER_API_KEY }),
      })
      return p(modelName)
    }

    case 'opencode-zen': {
      const p = createOpenAI({
        baseURL: config.OPENCODE_BASE_URL ?? PROVIDER_BASE_URLS['opencode-zen'],
        ...(config.OPENCODE_API_KEY && { apiKey: config.OPENCODE_API_KEY }),
      })
      return p(modelName)
    }

    default:
      throw new Error(
        `不支援的 AI provider: ${provider}。支援的 provider: ${SUPPORTED_PROVIDERS.join(', ')}`,
      )
  }
}

// ────────────────────────────────────────────
// createEmbeddingModelFromId
// ────────────────────────────────────────────

/**
 * 從 `provider/model-name` 格式建立 embedding 模型。
 *
 * 使用與聊天模型相同的 provider API 設定，無獨立的 embedding 憑證。
 */
export function createEmbeddingModelFromId(modelId: string, config: Config): EmbeddingModel {
  const { provider, modelName } = parseModelId(modelId)

  switch (provider) {
    case 'openai': {
      const p = createOpenAI({
        ...(config.OPENAI_BASE_URL && { baseURL: config.OPENAI_BASE_URL }),
        ...(config.OPENAI_API_KEY && { apiKey: config.OPENAI_API_KEY }),
      })
      return p.embedding(modelName)
    }

    case 'google': {
      const p = createGoogleGenerativeAI({
        ...(config.GOOGLE_BASE_URL && { baseURL: config.GOOGLE_BASE_URL }),
        ...(config.GOOGLE_API_KEY && { apiKey: config.GOOGLE_API_KEY }),
      })
      return p.embedding(modelName)
    }

    case 'openrouter': {
      const p = createOpenAI({
        baseURL: config.OPENROUTER_BASE_URL ?? PROVIDER_BASE_URLS.openrouter,
        ...(config.OPENROUTER_API_KEY && { apiKey: config.OPENROUTER_API_KEY }),
      })
      return p.embedding(modelName)
    }

    case 'opencode-zen': {
      const p = createOpenAI({
        baseURL: config.OPENCODE_BASE_URL ?? PROVIDER_BASE_URLS['opencode-zen'],
        ...(config.OPENCODE_API_KEY && { apiKey: config.OPENCODE_API_KEY }),
      })
      return p.embedding(modelName)
    }

    case 'anthropic':
      throw new Error('Anthropic 不支援 embedding 模型')

    default:
      throw new Error(
        `不支援的 embedding provider: ${provider}。支援的 provider: ${SUPPORTED_PROVIDERS.join(', ')}`,
      )
  }
}
