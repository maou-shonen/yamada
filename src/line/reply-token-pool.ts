/**
 * ReplyTokenPool — 管理 LINE replyToken 的 FIFO 池
 *
 * WHY：LINE replyToken 有 TTL（實際 ~60 秒），且每個 token 只能用一次。
 * 當 AI 生成多個回覆時，需要為每個回覆分配不同的 token。
 * 此類按群組隔離，以 FIFO 順序分配 token，自動清理過期 token。
 *
 * 設計：
 * - 內部使用 Map<groupId, Array<{token, storedAt}>>
 * - store() 追加 token 到群組陣列
 * - claim() 從陣列開頭（最舊）取出第一個有效 token，跳過並移除過期 token
 * - clear() 清空所有群組
 */

interface StoredToken {
  token: string
  storedAt: number
}

export class ReplyTokenPool {
  private pool: Map<string, StoredToken[]> = new Map()
  private freshnessMs: number
  private getNow: () => number

  /**
   * @param freshnessMs - Token 有效期限（毫秒）。超過此時間的 token 視為過期
   * @param getNow - 取得當前時間的函式（預設 Date.now，可注入用於測試）
   */
  constructor(freshnessMs: number, getNow?: () => number) {
    this.freshnessMs = freshnessMs
    this.getNow = getNow ?? (() => Date.now())
  }

  /**
   * 存放 token 到指定群組
   * @param groupId - 群組 ID
   * @param token - LINE replyToken
   */
  store(groupId: string, token: string): void {
    if (!this.pool.has(groupId)) {
      this.pool.set(groupId, [])
    }
    const tokens = this.pool.get(groupId)!
    tokens.push({
      token,
      storedAt: this.getNow(),
    })
  }

  /**
   * 從指定群組領取一個有效的 token（FIFO）
   * 自動跳過並移除過期 token
   * @param groupId - 群組 ID
   * @returns 有效的 token，或 null（無有效 token）
   */
  claim(groupId: string): string | null {
    const tokens = this.pool.get(groupId)
    if (!tokens || tokens.length === 0) {
      return null
    }

    const now = this.getNow()

    // 從陣列開頭（最舊）開始遍歷，跳過過期 token
    while (tokens.length > 0) {
      const stored = tokens[0]
      const age = now - stored.storedAt

      if (age >= this.freshnessMs) {
        // 過期，移除並繼續
        tokens.shift()
        continue
      }

      // 找到有效 token，移除並返回
      tokens.shift()

      // 如果陣列已空，刪除群組 key
      if (tokens.length === 0) {
        this.pool.delete(groupId)
      }

      return stored.token
    }

    // 所有 token 都過期，刪除群組 key
    this.pool.delete(groupId)
    return null
  }

  /**
   * 清空所有群組的 token
   */
  clear(): void {
    this.pool.clear()
  }
}
