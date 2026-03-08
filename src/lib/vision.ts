import type { LanguageModel } from 'ai'
import type { Buffer } from 'node:buffer'

import type { Config } from '../config/index.ts'
import { generateText } from 'ai'

import { log } from '../logger'
import { createModelFromId, parseModelList } from './provider.ts'

const visionLog = log.withPrefix('[Vision]')

const DESCRIPTION_PROMPT = 'Describe this image concisely in 1-2 sentences. Focus on the key visual elements.'
const DEFAULT_ANALYSIS_PROMPT = 'Analyze this image in detail. Focus on the key visual elements, context, and anything notable.'

export interface VisionDeps {
  generateText: typeof import('ai').generateText
  createModel: (modelId: string, config: Config) => LanguageModel
}

const defaultDeps: VisionDeps = {
  generateText,
  createModel: createModelFromId,
}

async function generateVisionText(
  imageBuffer: Buffer,
  prompt: string,
  config: Config,
  deps: VisionDeps = defaultDeps,
): Promise<string> {
  const models = parseModelList(config.VISION_MODEL!)

  let lastError: unknown

  for (let i = 0; i < models.length; i++) {
    const { provider, modelName } = models[i]
    const fullModelId = `${provider}/${modelName}`

    try {
      visionLog
        .withMetadata({
          model: fullModelId,
          promptLength: prompt.length,
          imageBytes: imageBuffer.byteLength,
        })
        .info('Sending request to vision model')

      const model = deps.createModel(fullModelId, config)
      const result = await deps.generateText({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', image: imageBuffer },
          ],
        }],
      })

      visionLog
        .withMetadata({
          model: fullModelId,
          responseLength: result.text.length,
        })
        .info('Vision response received')

      return result.text
    }
    catch (error) {
      lastError = error
      const isLastModel = i === models.length - 1
      if (!isLastModel) {
        visionLog
          .withMetadata({ failedModel: fullModelId, nextModel: `${models[i + 1].provider}/${models[i + 1].modelName}` })
          .warn('Vision model failed, trying fallback')
      }
    }
  }

  throw lastError
}

export async function generateImageDescription(
  imageBuffer: Buffer,
  config: Config,
  deps: VisionDeps = defaultDeps,
): Promise<string> {
  return generateVisionText(imageBuffer, DESCRIPTION_PROMPT, config, deps)
}

export async function analyzeImage(
  imageBuffer: Buffer,
  question: string,
  config: Config,
  deps: VisionDeps = defaultDeps,
): Promise<string> {
  return generateVisionText(
    imageBuffer,
    question.trim() || DEFAULT_ANALYSIS_PROMPT,
    config,
    deps,
  )
}
