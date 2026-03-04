import type { LanguageModel } from 'ai'
import type { Config } from '../config/index.ts'
import { generateObject } from 'ai'
import { z } from 'zod'
import { buildFactExtractionPrompt } from '../prompts/facts.ts'
import { generateWithFallback } from './llm-utils.ts'
import { createModelFromId, parseModelList } from './provider.ts'

interface FactMessage {
  userId: string
  userName: string
  content: string
  createdAt: number
}

interface ExistingFactInput {
  id: number
  scope: 'user' | 'group'
  userId: string | null
  canonicalKey: string
  content: string
  confidence: number
}

export interface FactExtractionResult {
  action: 'insert' | 'update' | 'supersede'
  scope: 'user' | 'group'
  userId?: string
  canonicalKey: string
  content: string
  confidence: number
  targetFactId?: number
}

const factExtractionResultSchema = z
  .object({
    action: z.enum(['insert', 'update', 'supersede']),
    scope: z.enum(['user', 'group']),
    userId: z.string().min(1).optional(),
    canonicalKey: z.string().min(1),
    content: z.string().min(1),
    confidence: z.number(),
    targetFactId: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'user' && !value.userId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['userId'],
        message: 'scope 為 user 時必須提供 userId',
      })
    }

    if (value.action === 'supersede' && value.targetFactId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetFactId'],
        message: 'action 為 supersede 時必須提供 targetFactId',
      })
    }
  })

const factExtractionArraySchema = z.array(factExtractionResultSchema)

export interface FactExtractorDeps {
  generateObject: typeof generateObject
  generateWithFallback: typeof generateWithFallback
  createModel: (modelId: string, config: Config) => LanguageModel
}

export const defaultDeps: FactExtractorDeps = {
  generateObject,
  generateWithFallback,
  createModel: createModelFromId,
}

function normalizeCanonicalKey(canonicalKey: string): string {
  return canonicalKey
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
}

export async function extractFacts(
  messages: FactMessage[],
  existingFacts: ExistingFactInput[],
  config: Config,
  deps: Partial<FactExtractorDeps> = {},
): Promise<FactExtractionResult[]> {
  if (messages.length === 0)
    return []

  const resolvedDeps: FactExtractorDeps = {
    ...defaultDeps,
    ...deps,
  }

  const aliasMap = messages.reduce<Record<string, string>>((acc, message) => {
    acc[message.userId] = message.userName
    return acc
  }, {})

  const prompt = buildFactExtractionPrompt(messages, existingFacts, aliasMap)
  const models = parseModelList(config.OBSERVER_MODEL)
  let parsedResults: FactExtractionResult[] | null = null

  for (const { provider, modelName } of models) {
    const modelId = `${provider}/${modelName}`
    try {
      const { object } = await resolvedDeps.generateObject({
        model: resolvedDeps.createModel(modelId, config),
        schema: factExtractionArraySchema,
        prompt,
      })
      parsedResults = object
      break
    }
    catch {
      continue
    }
  }

  if (!parsedResults) {
    const rawText = await resolvedDeps.generateWithFallback(prompt, config)
    const parsedJson = JSON.parse(rawText)
    parsedResults = factExtractionArraySchema.parse(parsedJson)
  }

  const existingFactIds = new Set(existingFacts.map(f => f.id))

  const normalized = parsedResults
    .map((item) => {
      const confidence = item.confidence
      if (confidence < 0 || confidence > 1)
        return null

      const canonicalKey = normalizeCanonicalKey(item.canonicalKey)
      // 正規化後可能變為空字串（例如全符號的 key），過濾掉
      if (!canonicalKey)
        return null

      const nextItem: FactExtractionResult = {
        ...item,
        canonicalKey,
      }

      if (nextItem.scope === 'group')
        delete nextItem.userId

      // supersede 的 targetFactId 必須是既有 active fact，否則丟棄
      if (nextItem.action === 'supersede' && nextItem.targetFactId !== undefined) {
        if (!existingFactIds.has(nextItem.targetFactId))
          return null
      }

      return nextItem
    })
    .filter((item): item is FactExtractionResult => item !== null)

  return factExtractionArraySchema.parse(normalized)
}
