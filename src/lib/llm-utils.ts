import type { LanguageModel } from 'ai'
import type { Config } from '../config/index.ts'
import { generateText } from 'ai'
import { log } from '../logger'
import { createModelFromId, parseModelList } from './provider.ts'

const llmUtilsLog = log.withPrefix('[LlmUtils]')

export interface LlmUtilsDeps {
  generateText: typeof import('ai').generateText
  createModel: (modelId: string, config: Config) => LanguageModel
}

const defaultLlmUtilsDeps: LlmUtilsDeps = {
  generateText,
  createModel: createModelFromId,
}

/**
 * 使用 OBSERVER_MODEL 的 fallback 列表呼叫 LLM。
 * 依序嘗試每個模型，失敗時自動切換到下一個。
 */
export async function generateWithFallback(
  prompt: string,
  config: Config,
  deps: LlmUtilsDeps = defaultLlmUtilsDeps,
): Promise<string> {
  const models = parseModelList(config.OBSERVER_MODEL)
  let lastError: unknown

  for (let i = 0; i < models.length; i++) {
    const { provider, modelName } = models[i]
    const fullModelId = `${provider}/${modelName}`

    try {
      const result = await deps.generateText({
        model: deps.createModel(fullModelId, config),
        messages: [{ role: 'user', content: prompt }],
      })
      return result.text
    }
    catch (error) {
      lastError = error
      const isLastModel = i === models.length - 1
      if (!isLastModel) {
        llmUtilsLog
          .withMetadata({ failedModel: fullModelId, nextModel: `${models[i + 1].provider}/${models[i + 1].modelName}` })
          .warn('LLM model failed, trying fallback')
      }
    }
  }

  throw lastError
}
