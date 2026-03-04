type FactMessage = {
  userId: string
  userName: string
  content: string
  createdAt: number
}

type ExistingFact = {
  id: number
  scope: 'user' | 'group'
  userId: string | null
  canonicalKey: string
  content: string
  confidence: number
}

export function buildFactExtractionPrompt(
  messages: FactMessage[],
  existingFacts: ExistingFact[],
  aliasMap: Record<string, string>,
): string {
  const messagesText = JSON.stringify(messages, null, 2)
  const existingFactsText = JSON.stringify(existingFacts, null, 2)
  const aliasMapText = JSON.stringify(aliasMap, null, 2)

  return `你是一個對話事實抽取器。請閱讀對話並抽取可長期保存的高信心事實。

任務要求：
1. 讀取 conversation_messages，找出可抽取事實。
2. 區分 scope：
   - user: 關於特定人的事實（必須提供 userId）
   - group: 關於整個群組的共同事實
3. 參考 existing_facts 判斷 action：
   - insert: 全新事實
   - update: 與既有同 canonicalKey 但內容更完整或更新
   - supersede: 與既有事實矛盾（必須提供 targetFactId）
4. canonicalKey 必須是 lowercase snake_case，並優先使用穩定鍵名。
   可參考：pet_preference、birthday、occupation、food_preference、group_tradition、meeting_schedule、hobby、location。
5. 忽略玩笑、反串、角色扮演、明顯諷刺或低可信內容，只保留高信心事實。
6. bot 訊息已在上游過濾，不需額外處理。

輸入資料：
- alias_map（userId -> displayName）
${aliasMapText}

- conversation_messages
${messagesText}

- existing_facts
${existingFactsText}

輸出格式：
- 只輸出 JSON 陣列，不要加任何額外文字。
- 每個元素都必須符合以下 schema：
{
  "action": "insert" | "update" | "supersede",
  "scope": "user" | "group",
  "userId"?: string,             // scope=user 時必填
  "canonicalKey": string,        // lowercase snake_case
  "content": string,
  "confidence": number,          // 0.0 到 1.0
  "targetFactId"?: number        // action=supersede 時必填
}

約束：
- scope="user" 時，userId 必須來自 conversation_messages。
- scope="group" 時，不要輸出 userId。
- action="supersede" 時，targetFactId 必須指向 existing_facts 中的 id。
- 若沒有可靠新事實，輸出空陣列 []。`
}
