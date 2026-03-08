import type { LanguageModel } from 'ai'
import type { Config } from '../config/index.ts'
import type { UserMask } from './alias-replacer.ts'
import { generateObject } from 'ai'
import { z } from 'zod'
import { buildFactExtractionPrompt } from '../prompts/facts.ts'
import { logAiRequest } from './ai-logger.ts'
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

/**
 * 依序嘗試模型進行 facts 萃取，優先使用 structured output，失敗才降級為文字 JSON。
 *
 * WHY：把「雙層呼叫策略」集中，讓 extractFacts 保持高層流程可讀性。
 */
async function callFactExtractionLlm(
  prompt: string,
  models: ReturnType<typeof parseModelList>,
  config: Config,
  deps: FactExtractorDeps,
  groupId?: string,
): Promise<FactExtractionResult[]> {
  for (const { provider, modelName } of models) {
    const modelId = `${provider}/${modelName}`
    const attemptStart = Date.now()
    try {
      const result = await deps.generateObject({
        model: deps.createModel(modelId, config),
        schema: factExtractionArraySchema,
        prompt,
      })
      logAiRequest({
        callType: 'fact-extraction',
        groupId: groupId ?? 'unknown',
        model: modelId,
        durationMs: Date.now() - attemptStart,
        input: prompt,
        output: { factCount: result.object.length, facts: result.object },
        usage: {
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          totalTokens: result.usage?.totalTokens ?? null,
        },
      })
      return result.object
    }
    catch (error) {
      logAiRequest({
        callType: 'fact-extraction',
        groupId: groupId ?? 'unknown',
        model: modelId,
        durationMs: Date.now() - attemptStart,
        input: prompt,
        output: null,
        error,
      })
      continue
    }
  }

  const fallbackStart = Date.now()
  const rawText = await deps.generateWithFallback(prompt, config)
  logAiRequest({
    callType: 'fact-extraction',
    groupId: groupId ?? 'unknown',
    model: 'fallback',
    durationMs: Date.now() - fallbackStart,
    input: prompt,
    output: rawText,
  })
  const parsedJson = JSON.parse(rawText)
  return factExtractionArraySchema.parse(parsedJson)
}

/**
 * 正規化並驗證 LLM 萃取結果，移除不合法或無法套用的項目。
 *
 * WHY：把資料清洗規則集中，避免業務流程中混雜細節判斷。
 */
function normalizeAndValidateResults(
  parsedResults: FactExtractionResult[],
  existingFacts: ExistingFactInput[],
): FactExtractionResult[] {
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

export async function extractFacts(
  messages: FactMessage[],
  existingFacts: ExistingFactInput[],
  config: Config,
  userMask?: UserMask,
  deps: Partial<FactExtractorDeps> = {},
  groupId?: string,
): Promise<FactExtractionResult[]> {
  if (messages.length === 0)
    return []

  const resolvedDeps: FactExtractorDeps = {
    ...defaultDeps,
    ...deps,
  }

  // ── 1) 由訊息與既有 facts 組裝 prompt ──
  const prompt = buildFactExtractionPrompt(messages, existingFacts)
  const models = parseModelList(config.OBSERVER_MODEL)

  // ── 2) 呼叫 LLM（structured output 優先，文字 JSON 後備）──
  const parsedResults = await callFactExtractionLlm(prompt, models, config, resolvedDeps, groupId)

  // ── 3) 正規化與驗證，必要時將 alias 還原為原始 userId ──
  const normalizedResults = normalizeAndValidateResults(parsedResults, existingFacts)

  if (!userMask)
    return normalizedResults

  return normalizedResults.map((result) => {
    if (!result.userId)
      return result

    return {
      ...result,
      userId: userMask.unmask(result.userId),
    }
  })
}
