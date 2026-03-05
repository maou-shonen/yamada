import type { Database } from 'bun:sqlite'
import type { DB } from './db'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestDb } from '../__tests__/helpers/setup-db.ts'
import {
  getAllActiveFacts,
  getFactsByUser,
  getFactWatermark,
  getGroupFacts,
  getPinnedFacts,
  setFactWatermark,
  supersedeFact,
  upsertFact,
} from './facts'
import * as schema from './schema'

let db: DB
let sqlite: Database

beforeEach(() => {
  const testDb = setupTestDb()
  db = testDb.db
  sqlite = testDb.sqlite
})

afterEach(() => {
  sqlite.close()
})

// ─── upsertFact ───

describe('upsertFact', () => {
  test('insert new user fact — appears in getFactsByUser with evidence_count=1', () => {
    upsertFact(db, {
      scope: 'user',
      userId: 'u1',
      canonicalKey: 'favorite_food',
      content: 'Alice likes sushi',
    })

    const facts = getFactsByUser(db, 'u1')
    expect(facts).toHaveLength(1)
    expect(facts[0].content).toBe('Alice likes sushi')
    expect(facts[0].evidenceCount).toBe(1)
    expect(facts[0].scope).toBe('user')
  })

  test('insert new group fact — appears in getGroupFacts with evidence_count=1', () => {
    upsertFact(db, {
      scope: 'group',
      canonicalKey: 'weekly_meeting',
      content: 'Weekly meeting on Monday',
    })

    const facts = getGroupFacts(db)
    expect(facts).toHaveLength(1)
    expect(facts[0].content).toBe('Weekly meeting on Monday')
    expect(facts[0].evidenceCount).toBe(1)
    expect(facts[0].scope).toBe('group')
  })

  test('upsert same (canonical_key, scope, user_id) — updates content and increments evidence_count', () => {
    upsertFact(db, {
      scope: 'user',
      userId: 'u1',
      canonicalKey: 'favorite_food',
      content: 'Alice likes sushi',
    })

    upsertFact(db, {
      scope: 'user',
      userId: 'u1',
      canonicalKey: 'favorite_food',
      content: 'Alice loves ramen now',
    })

    const facts = getFactsByUser(db, 'u1')
    expect(facts).toHaveLength(1)
    expect(facts[0].content).toBe('Alice loves ramen now')
    expect(facts[0].evidenceCount).toBe(2)
  })
})

// ─── supersedeFact ───

describe('supersedeFact', () => {
  test('marks fact as superseded — hidden from default query, visible with status filter', () => {
    upsertFact(db, {
      scope: 'user',
      userId: 'u1',
      canonicalKey: 'job',
      content: 'Alice is a student',
    })

    const before = getFactsByUser(db, 'u1')
    expect(before).toHaveLength(1)

    supersedeFact(db, before[0].id)

    expect(getFactsByUser(db, 'u1')).toHaveLength(0)

    const superseded = getFactsByUser(db, 'u1', 'superseded')
    expect(superseded).toHaveLength(1)
    expect(superseded[0].status).toBe('superseded')
  })
})

// ─── getFactsByUser ───

describe('getFactsByUser', () => {
  test('returns only active facts by default', () => {
    upsertFact(db, { scope: 'user', userId: 'u1', canonicalKey: 'k1', content: 'active fact' })
    upsertFact(db, { scope: 'user', userId: 'u1', canonicalKey: 'k2', content: 'will be superseded' })

    const all = getFactsByUser(db, 'u1')
    expect(all).toHaveLength(2)

    supersedeFact(db, all.find(f => f.canonicalKey === 'k2')!.id)

    const afterSupersede = getFactsByUser(db, 'u1')
    expect(afterSupersede).toHaveLength(1)
    expect(afterSupersede[0].content).toBe('active fact')
  })

  test('returns facts for specific userId only', () => {
    upsertFact(db, { scope: 'user', userId: 'u1', canonicalKey: 'k1', content: 'user1 fact' })
    upsertFact(db, { scope: 'user', userId: 'u2', canonicalKey: 'k2', content: 'user2 fact' })

    const u1 = getFactsByUser(db, 'u1')
    expect(u1).toHaveLength(1)
    expect(u1[0].content).toBe('user1 fact')

    const u2 = getFactsByUser(db, 'u2')
    expect(u2).toHaveLength(1)
    expect(u2[0].content).toBe('user2 fact')
  })

  test('returns empty array for unknown userId', () => {
    expect(getFactsByUser(db, 'nonexistent')).toEqual([])
  })
})

// ─── getGroupFacts ───

describe('getGroupFacts', () => {
  test('returns only group-scope facts, not user-scope', () => {
    upsertFact(db, { scope: 'group', canonicalKey: 'g1', content: 'group fact' })
    upsertFact(db, { scope: 'user', userId: 'u1', canonicalKey: 'u1', content: 'user fact' })

    const facts = getGroupFacts(db)
    expect(facts).toHaveLength(1)
    expect(facts[0].content).toBe('group fact')
  })
})

// ─── getPinnedFacts ───

describe('getPinnedFacts', () => {
  test('returns pinned facts for specific user (scope=user, pinned=true)', () => {
    const now = Date.now()
    db.insert(schema.facts).values({
      scope: 'user',
      userId: 'u1',
      canonicalKey: 'pinned_user',
      content: 'important user fact',
      confidence: 1.0,
      evidenceCount: 1,
      status: 'active',
      pinned: true,
      createdAt: now,
      updatedAt: now,
    }).run()

    // non-pinned user fact
    upsertFact(db, { scope: 'user', userId: 'u1', canonicalKey: 'normal', content: 'normal fact' })

    const pinned = getPinnedFacts(db, 'u1')
    expect(pinned).toHaveLength(1)
    expect(pinned[0].content).toBe('important user fact')
  })

  test('returns group pinned facts when no userId provided', () => {
    const now = Date.now()
    db.insert(schema.facts).values({
      scope: 'group',
      userId: null,
      canonicalKey: 'group_pinned',
      content: 'important group fact',
      confidence: 1.0,
      evidenceCount: 1,
      status: 'active',
      pinned: true,
      createdAt: now,
      updatedAt: now,
    }).run()

    const pinned = getPinnedFacts(db)
    expect(pinned).toHaveLength(1)
    expect(pinned[0].content).toBe('important group fact')
  })

  test('does NOT return non-pinned facts', () => {
    upsertFact(db, { scope: 'user', userId: 'u1', canonicalKey: 'k1', content: 'not pinned' })
    upsertFact(db, { scope: 'group', canonicalKey: 'k2', content: 'not pinned either' })

    expect(getPinnedFacts(db, 'u1')).toHaveLength(0)
  })
})

// ─── getAllActiveFacts ───

describe('getAllActiveFacts', () => {
  test('returns all active facts (both user and group scope)', () => {
    upsertFact(db, { scope: 'user', userId: 'u1', canonicalKey: 'k1', content: 'user fact' })
    upsertFact(db, { scope: 'group', canonicalKey: 'k2', content: 'group fact' })

    expect(getAllActiveFacts(db)).toHaveLength(2)
  })

  test('does NOT return superseded facts', () => {
    upsertFact(db, { scope: 'user', userId: 'u1', canonicalKey: 'k1', content: 'will supersede' })
    upsertFact(db, { scope: 'group', canonicalKey: 'k2', content: 'stays active' })

    const all = getAllActiveFacts(db)
    supersedeFact(db, all.find(f => f.canonicalKey === 'k1')!.id)

    const after = getAllActiveFacts(db)
    expect(after).toHaveLength(1)
    expect(after[0].canonicalKey).toBe('k2')
  })
})

// ─── Watermark ───

describe('getFactWatermark / setFactWatermark', () => {
  test('returns 0 on empty DB', () => {
    expect(getFactWatermark(db)).toBe(0)
  })

  test('set then get returns the value', () => {
    setFactWatermark(db, 1700000000000)
    expect(getFactWatermark(db)).toBe(1700000000000)
  })

  test('calling set twice updates the value (upsert behavior)', () => {
    setFactWatermark(db, 1700000000000)
    setFactWatermark(db, 1800000000000)
    expect(getFactWatermark(db)).toBe(1800000000000)
  })
})
