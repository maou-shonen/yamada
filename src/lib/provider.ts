import type { EmbeddingModel, LanguageModel } from 'ai'
import type { Config } from '../config/index.ts'
import { envProvider } from 'ai-sdk-provider-env'

const provider = envProvider()

// ────────────────────────────────────────────
// Model ID 解析
// ────────────────────────────────────────────

export interface ParsedModel {
  provider: string
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

  if (!provider) {
    throw new Error(
      `無效的 model ID 格式: "${modelId}"。provider 前綴不可為空`,
    )
  }

  if (!modelName) {
    throw new Error(
      `無效的 model ID 格式: "${modelId}"。model 名稱不可為空`,
    )
  }

  return { provider, modelName }
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
export function createModelFromId(modelId: string, _config: Config): LanguageModel {
  return provider.languageModel(modelId)
}

// ────────────────────────────────────────────
// createEmbeddingModelFromId
// ────────────────────────────────────────────

/**
 * 從 `provider/model-name` 格式建立 embedding 模型。
 *
 * 使用與聊天模型相同的 provider API 設定，無獨立的 embedding 憑證。
 */
export function createEmbeddingModelFromId(modelId: string, _config: Config): EmbeddingModel {
  return provider.embeddingModel(modelId)
}
