import type { ModelMessage } from 'ai'
import type { Config } from '../config/index.ts'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { log } from '../logger'
import { createProvider } from './provider.ts'

const aiLog = log.withPrefix('[AI]')

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * AI 決定的動作類型。
 * 每次 generateReply 回傳一個 actions 陣列，代表 AI 在這輪對話中做出的所有決定。
 * WHY union type：讓呼叫端能用 switch(action.type) 精確處理每種行為，
 * 且新增動作類型時 TypeScript 會強制所有 switch 都處理。
 */
export type AgentAction
  = | { type: 'reply', content: string }
    | { type: 'reaction', emoji: string }
    | { type: 'skip', reason: string }

export interface GenerateReplyResult {
  actions: AgentAction[]
  usage: TokenUsage
}

export interface GeneratorDeps {
  generateText: typeof import('ai').generateText
  createModel: (config: Config) => ReturnType<typeof createModel>
}

function createModel(config: Config) {
  const provider = createProvider(config)
  return provider.chat(config.AI_MODEL)
}

const defaultDeps: GeneratorDeps = {
  generateText,
  createModel,
}

/**
 * 定義 AI agent 可用的 tools。
 *
 * WHY tool-based：讓 AI 自主決定「要不要回」「怎麼回」「要不要加 reaction」，
 * 而非由程式碼硬編碼。搭配 toolChoice: 'required' 強制 AI 每次都做出明確選擇。
 *
 * 注意：這些 tool 的 execute 只回傳確認訊息，實際投遞由 Agent 根據 toolCalls 執行。
 * WHY 不在 execute 中直接投遞：generator 不該依賴 channel/platform 等基礎設施，
 * 保持純粹的「AI 決策」職責。
 */
function createAgentTools() {
  return {
    reply: tool({
      description: '回覆訊息到群組聊天',
      inputSchema: z.object({
        content: z.string().describe('回覆的文字內容'),
      }),
      execute: async ({ content }) => ({ delivered: true, content }),
    }),
    reaction: tool({
      description: '對最近的訊息加一個 emoji 反應，適合不需要完整回覆但想表達態度的場景',
      inputSchema: z.object({
        emoji: z.string().describe('要反應的 emoji，例如 👍、❤️、😂'),
      }),
      execute: async ({ emoji }) => ({ delivered: true, emoji }),
    }),
    skip: tool({
      description: '這段對話不需要回應，選擇保持沉默。當對話與你無關、不需要你參與、或插嘴會打斷別人時使用',
      inputSchema: z.object({
        reason: z.string().describe('選擇不回應的原因（內部記錄用，不會顯示給用戶）'),
      }),
      execute: async ({ reason }) => ({ skipped: true, reason }),
    }),
  }
}

/**
 * 呼叫 LLM 並讓 AI 透過 tools 決定如何回應。
 *
 * WHY toolChoice: 'required'：強制 AI 必須呼叫至少一個 tool，
 * 避免「不 call tool 也不 skip」的模糊狀態——每次都有明確信號。
 *
 * WHY stopWhen: stepCountIs(2)：允許 AI 連續使用 2 個 tool（例如 reaction + reply），
 * 但避免無限迴圈。
 */
export async function generateReply(
  messages: ModelMessage[],
  config: Config,
  deps: GeneratorDeps = defaultDeps,
): Promise<GenerateReplyResult> {
  aiLog
    .withMetadata({
      model: config.AI_MODEL,
      provider: config.AI_PROVIDER,
      totalMessages: messages.length,
    })
    .info('Sending request to LLM')

  const model = deps.createModel(config)
  const result = await deps.generateText({
    model,
    messages,
    tools: createAgentTools(),
    toolChoice: 'required',
    stopWhen: stepCountIs(2),
  })

  const usage: TokenUsage = {
    promptTokens: result.usage.inputTokens ?? 0,
    completionTokens: result.usage.outputTokens ?? 0,
    totalTokens: result.usage.totalTokens ?? 0,
  }

  // 從所有 steps 中提取 AI 的決策
  // WHY 過濾 dynamic：只處理我們定義的 tool，忽略 dynamic tool calls（不應出現但防禦性處理）
  const actions: AgentAction[] = []
  for (const step of result.steps) {
    for (const toolCall of step.toolCalls) {
      if (toolCall.dynamic)
        continue
      switch (toolCall.toolName) {
        case 'reply':
          actions.push({ type: 'reply', content: toolCall.input.content })
          break
        case 'reaction':
          actions.push({ type: 'reaction', emoji: toolCall.input.emoji })
          break
        case 'skip':
          actions.push({ type: 'skip', reason: toolCall.input.reason })
          break
      }
    }
  }

  aiLog
    .withMetadata({
      model: config.AI_MODEL,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      actionCount: actions.length,
      actionTypes: actions.map(a => a.type),
    })
    .info('LLM response received')

  return { actions, usage }
}
