/**
 * 純粹的 userId ↔ alias 轉換工具函式。
 * 無副作用、無 DB 存取、無外部依賴。
 *
 * 兩個層級：
 * - 值層級：UserMask — 單一值的 userId ↔ alias 雙向映射
 * - 文字層級：replaceUserIdsWithAliases / replaceAliasesWithNames / sanitizeDiscordMentions
 */

// ── 值層級：雙向掩碼映射 ──

/**
 * 雙向 userId ↔ alias 掩碼映射。
 *
 * 設計：LLM 只看到 alias，永遠不看到原始平台 ID。
 * mask = userId → alias（送入 LLM 前）
 * unmask = alias → userId（從 LLM 結果取回後）
 */
export interface UserMask {
  /** 將原始 userId 轉為 alias。找不到則回傳原值。 */
  mask: (userId: string) => string
  /** 將 alias 轉回原始 userId。找不到則回傳原值。 */
  unmask: (alias: string) => string
}

export function createUserMask(
  aliasMap: Map<string, { alias: string, userName: string }>,
): UserMask {
  const userIdToAlias = new Map<string, string>()
  const aliasToUserId = new Map<string, string>()

  for (const [userId, value] of aliasMap.entries()) {
    userIdToAlias.set(userId, value.alias)
    aliasToUserId.set(value.alias, userId)
  }

  return {
    mask(userId: string): string {
      return userIdToAlias.get(userId) ?? userId
    },
    unmask(alias: string): string {
      return aliasToUserId.get(alias) ?? alias
    },
  }
}

// ── 文字層級：字串替換 ──

/**
 * 替換 `{userId}: ` 前綴模式為 `{alias}: `。
 *
 * 用途：buildChatMessages 和 formatChatHistory 產生的格式
 * 格式：`${userId}: ${content}` 在行首或換行後
 *
 * @param text 輸入文本
 * @param aliasMap userId → alias 的映射
 * @returns 替換後的文本，未識別的 userId 保持不變
 *
 * 實作細節：
 * - 單次 regex 交替（無級聯替換）
 * - 按 key 長度降序排序（防止短 key 部分匹配長 key）
 * - 多行模式 (gm flag) 匹配行首
 */
export function replaceUserIdsWithAliases(
  text: string,
  aliasMap: Map<string, string>,
): string {
  if (aliasMap.size === 0)
    return text

  // 按長度降序排序，防止短 key 部分匹配長 key
  const sortedKeys = Array.from(aliasMap.keys()).sort(
    (a, b) => b.length - a.length,
  )

  // 逃脫 regex 特殊字元
  const escapedKeys = sortedKeys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  // 單次 regex 交替：^(key1|key2|...):
  const pattern = new RegExp(`^(${escapedKeys.join('|')}): `, 'gm')

  return text.replace(pattern, (match, userId) => {
    const alias = aliasMap.get(userId)
    return alias ? `${alias}: ` : match
  })
}

/**
 * 替換自由文本中的 alias 出現為 userName。
 *
 * 用途：observer 摘要中的 alias 替換為真實名稱
 * 例如：「user_bright_owl 說...」→ 「Alice 說...」
 *
 * @param text 輸入文本
 * @param reverseMap alias → userName 的映射
 * @returns 替換後的文本
 *
 * 實作細節：
 * - 單次 regex 交替（無級聯替換）
 * - 按 key 長度降序排序
 * - 不限制位置（自由文本中任何地方）
 */
export function replaceAliasesWithNames(
  text: string,
  reverseMap: Map<string, string>,
): string {
  if (reverseMap.size === 0)
    return text

  // 按長度降序排序
  const sortedKeys = Array.from(reverseMap.keys()).sort(
    (a, b) => b.length - a.length,
  )

  // 逃脫 regex 特殊字元
  const escapedKeys = sortedKeys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  // 單次 regex 交替：(alias1|alias2|...)
  const pattern = new RegExp(`(${escapedKeys.join('|')})`, 'g')

  return text.replace(pattern, (match) => {
    const userName = reverseMap.get(match)
    return userName ?? match
  })
}

/**
 * 清理 Discord mention 格式 `<@userId>` 和 `<@!userId>`。
 *
 * 用途：訊息內容中的 Discord mention 轉換為 alias
 * 格式：`<@123456789>` 或 `<@!123456789>` → `user_bright_owl`
 *
 * @param text 輸入文本
 * @param aliasMap userId → alias 的映射
 * @returns 替換後的文本，未識別的 mention 移除
 *
 * 實作細節：
 * - 單次 regex 匹配 `<@!?userId>`
 * - 如果 userId 在 map 中，替換為 alias；否則移除
 */
export function sanitizeDiscordMentions(
  text: string,
  aliasMap: Map<string, string>,
): string {
  // 匹配 <@userId> 或 <@!userId>
  // userId 可以是 Discord snowflake (純數字) 或其他格式
  const pattern = /<@!?(\d+)>/g

  return text.replace(pattern, (match, userId) => {
    const alias = aliasMap.get(userId)
    return alias ?? '' // 未識別則移除
  })
}
