import type { Database } from 'bun:sqlite'

interface TriggerStoreConfig {
  DEBOUNCE_SILENCE_MS: number
  DEBOUNCE_URGENT_MS: number
  DEBOUNCE_OVERFLOW_CHARS: number
}

interface PendingTriggerRow {
  pending_chars: number
  created_at: number
}

interface ClaimedTriggerRow {
  group_id: string
  platform: string
  is_mention: number
}

export function upsertTrigger(
  sqlite: Database,
  groupId: string,
  platform: string,
  isMention: boolean,
  contentLength: number,
  config: TriggerStoreConfig,
): void {
  const now = Date.now()
  const existing = sqlite.query(
    `SELECT pending_chars, created_at FROM pending_triggers WHERE group_id = ?`,
  ).get(groupId) as PendingTriggerRow | null

  const existingPendingChars = existing?.pending_chars ?? 0
  const newPendingChars = existingPendingChars + contentLength
  const delay = isMention ? config.DEBOUNCE_URGENT_MS : config.DEBOUNCE_SILENCE_MS
  const triggerAt = newPendingChars >= config.DEBOUNCE_OVERFLOW_CHARS
    ? now
    : now + delay

  if (!existing) {
    sqlite.run(
      `INSERT INTO pending_triggers (group_id, platform, trigger_at, pending_chars, is_mention, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [groupId, platform, triggerAt, newPendingChars, isMention ? 1 : 0, now, now],
    )
    return
  }

  sqlite.run(
    `UPDATE pending_triggers
     SET platform = ?, trigger_at = ?, pending_chars = ?, is_mention = MAX(is_mention, ?), status = 'pending', updated_at = ?
     WHERE group_id = ?`,
    [platform, triggerAt, newPendingChars, isMention ? 1 : 0, now, groupId],
  )
}

export function claimDueTriggers(
  sqlite: Database,
  now: number,
): Array<{ groupId: string, platform: string, isMention: boolean }> {
  const claimed = sqlite.query(
    `UPDATE pending_triggers
     SET status = 'processing', updated_at = ?
     WHERE status = 'pending' AND trigger_at <= ?
     RETURNING group_id, platform, is_mention`,
  ).all(now, now) as ClaimedTriggerRow[]

  return claimed.map(row => ({
    groupId: row.group_id,
    platform: row.platform,
    isMention: row.is_mention === 1,
  }))
}

export function completeTrigger(
  sqlite: Database,
  groupId: string,
): void {
  sqlite.run('DELETE FROM pending_triggers WHERE group_id = ?', [groupId])
}

export function recoverStaleTriggers(sqlite: Database): void {
  sqlite.run(
    `UPDATE pending_triggers
     SET status = 'pending', updated_at = ?
     WHERE status = 'processing'`,
    [Date.now()],
  )
}
