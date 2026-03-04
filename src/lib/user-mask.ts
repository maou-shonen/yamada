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
