/**
 * 純粹的 userId ↔ alias 文字替換工具函式。
 * 無副作用、無 DB 存取、無外部依賴。
 *
 * 三個替換模式：
 * 1. `${userId}: ${content}` → `${alias}: ${content}` (buildChatMessages 格式)
 * 2. alias 在自由文本中的出現 → userName (observer 摘要中)
 * 3. `<@userId>` 和 `<@!userId>` → alias (Discord mention 清理)
 */

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
