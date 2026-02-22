import type { Config } from '../config/index.ts'
import { createOpenAI, openai as defaultOpenAI } from '@ai-sdk/openai'

function createCustomProvider(baseUrl?: string, apiKey?: string) {
  return createOpenAI({
    ...(baseUrl && { baseURL: baseUrl }),
    ...(apiKey && { apiKey }),
  })
}

/**
 * 建立聊天用 provider，支援 self-hosted 和 proxy 端點。
 *
 * WHY fallback chain：許多使用者透過 LiteLLM、Ollama 等 proxy 自架 OpenAI 相容端點，
 * 或使用 Azure/自訂雲端部署。Fallback 鏈讓他們設定自訂端點，同時保持零設定預設值
 * （直接讀取 OPENAI_API_KEY 使用官方 OpenAI）。
 */
export function createProvider(config: Config) {
  if (!config.AI_BASE_URL && !config.AI_API_KEY) {
    return defaultOpenAI
  }
  return createCustomProvider(config.AI_BASE_URL, config.AI_API_KEY)
}

/**
 * 建立 embedding 用 provider，支援獨立端點配置。
 *
 * WHY 獨立 provider：Embedding 模型常運行在不同基礎設施或端點上（如 Qdrant、Milvus、
 * 或專用 embedding 服務），與聊天模型分離。雙層 fallback（embedding→chat→default）
 * 讓使用者可細粒度配置（只設 embedding 端點、只設聊天端點、都設、都不設），
 * 或完全不設定而使用預設值。
 */
export function createEmbeddingProvider(config: Config) {
  const baseUrl = config.EMBEDDING_BASE_URL ?? config.AI_BASE_URL
  const apiKey = config.EMBEDDING_API_KEY ?? config.AI_API_KEY

  if (!baseUrl && !apiKey) {
    return defaultOpenAI
  }
  return createCustomProvider(baseUrl, apiKey)
}
