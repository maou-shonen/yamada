/** 截斷字串至指定長度，超過時以 "..." 結尾 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength)
    return text
  return `${text.slice(0, maxLength - 3)}...`
}

const BRACKET_CONTENT_REGEX = /^\[[^\]]*\]$/

/**
 * 判斷內容是否適合做 embedding。
 * 排除空字串和 `[圖片]`、`[貼圖]` 等平台佔位符——
 * 這些不含語義資訊，embedding 後只會汙染向量空間。
 */
export function isEmbeddableContent(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed)
    return false
  if (BRACKET_CONTENT_REGEX.test(trimmed))
    return false
  return true
}

/** 粗估 token 數量：每 `ratio` 個字元約為 1 token */
export function estimateTokens(text: string, ratio: number): number {
  return Math.ceil(text.length / ratio)
}

/** 檢查內容是否包含 URL（http:// 或 https:// 開頭） */
export function containsUrl(content: string): boolean {
  return /https?:\/\/\S+/.test(content)
}
