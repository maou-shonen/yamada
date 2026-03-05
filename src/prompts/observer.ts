/**
 * Observer 壓縮用的 prompt 模板。
 * 獨立於 AI 呼叫邏輯，方便迭代措辭和調整格式。
 */

export function formatChatHistory(messages: { userId: string, content: string }[], aliasMap?: Map<string, string>): string {
  return messages.map(m => `${aliasMap?.get(m.userId) ?? m.userId}: ${m.content}`).join('\n')
}

export function buildGroupCompressionPrompt(existingSummary: string | null, historyText: string, pinnedFacts?: string): string {
  const factsBlock = pinnedFacts
    ? `已知事實（不要重複）：
${pinnedFacts}

以下事實已被獨立記錄，摘要中不需要重複這些資訊。摘要應專注於：近期互動氣氛、話題趨勢、情緒變化。

`
    : ''

  return `${factsBlock}以下是群組的對話歷史和（可能的）現有摘要。請更新群組摘要，包含：主要話題、群組氣氛、互動模式。保持簡潔。

現有摘要：
${existingSummary ?? '（無）'}

對話歷史：
${historyText}`
}

export function buildUserCompressionPrompt(existingSummary: string | null, messagesText: string, pinnedFacts?: string): string {
  const factsBlock = pinnedFacts
    ? `已知事實（不要重複）：
${pinnedFacts}

以下是此用戶的已知事實，摘要中不需要重複。摘要應專注於：近期互動風格、情緒狀態、當前關注話題。

`
    : ''

  return `${factsBlock}以下是這個用戶在群組中的發言和（可能的）現有摘要。作為朋友你會記住什麼？更新用戶側寫。

現有摘要：
${existingSummary ?? '（無）'}

用戶發言：
${messagesText}`
}
