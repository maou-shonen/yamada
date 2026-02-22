import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { ReplyTokenPool } from './reply-token-pool.ts'

describe('ReplyTokenPool', () => {
  let pool: ReplyTokenPool
  let now: number

  beforeEach(() => {
    now = 0
    pool = new ReplyTokenPool(1000, () => now)
  })

  afterEach(() => {
    pool.clear()
  })

  test('同群組存放多個 token → store 3 tokens for same groupId, verify claim returns them', () => {
    const groupId = 'group-1'

    // 存放 3 個 token
    pool.store(groupId, 'token-A')
    pool.store(groupId, 'token-B')
    pool.store(groupId, 'token-C')

    // 依序領取
    expect(pool.claim(groupId)).toBe('token-A')
    expect(pool.claim(groupId)).toBe('token-B')
    expect(pool.claim(groupId)).toBe('token-C')

    // 已無 token
    expect(pool.claim(groupId)).toBeNull()
  })

  test('FIFO 順序 → store(A, B, C), claim returns A first, then B, then C', () => {
    const groupId = 'group-fifo'

    pool.store(groupId, 'first')
    pool.store(groupId, 'second')
    pool.store(groupId, 'third')

    // FIFO：最先存放的最先領取
    expect(pool.claim(groupId)).toBe('first')
    expect(pool.claim(groupId)).toBe('second')
    expect(pool.claim(groupId)).toBe('third')
  })

  test('過期 token 被跳過 → store, advance time past freshnessMs, claim returns null', () => {
    const groupId = 'group-expire'

    // 在 now=0 時存放 token
    pool.store(groupId, 'old-token')

    // 時間推進超過 freshnessMs (1000ms)
    now = 1001

    // claim 應返回 null（token 已過期）
    expect(pool.claim(groupId)).toBeNull()
  })

  test('Lazy cleanup → expired entries are removed from internal array during claim traversal', () => {
    const groupId = 'group-cleanup'

    // 在 now=0 時存放 2 個 token
    pool.store(groupId, 'expired-1')
    pool.store(groupId, 'expired-2')

    // 時間推進超過 freshnessMs
    now = 1001

    // claim 應遍歷並移除過期 token，最後返回 null
    expect(pool.claim(groupId)).toBeNull()

    // 再次 claim 應返回 null（已清理）
    expect(pool.claim(groupId)).toBeNull()
  })

  test('Atomic claim → claimed token is removed, next claim gets next token', () => {
    const groupId = 'group-atomic'

    pool.store(groupId, 'token-1')
    pool.store(groupId, 'token-2')

    // 第一次 claim 移除 token-1
    const first = pool.claim(groupId)
    expect(first).toBe('token-1')

    // 第二次 claim 應得到 token-2（token-1 已移除）
    const second = pool.claim(groupId)
    expect(second).toBe('token-2')

    // 第三次 claim 應返回 null
    expect(pool.claim(groupId)).toBeNull()
  })

  test('空 pool → claim on empty/unknown group returns null', () => {
    // 未存放任何 token 的群組
    expect(pool.claim('unknown-group')).toBeNull()

    // 存放後全部領取，再 claim
    pool.store('group-empty', 'token')
    pool.claim('group-empty')
    expect(pool.claim('group-empty')).toBeNull()
  })

  test('跨群組隔離 → group A tokens not visible to group B claim', () => {
    const groupA = 'group-A'
    const groupB = 'group-B'

    pool.store(groupA, 'token-A1')
    pool.store(groupA, 'token-A2')
    pool.store(groupB, 'token-B1')
    pool.store(groupB, 'token-B2')

    // groupA 領取應只得到 groupA 的 token
    expect(pool.claim(groupA)).toBe('token-A1')
    expect(pool.claim(groupA)).toBe('token-A2')

    // groupB 領取應只得到 groupB 的 token
    expect(pool.claim(groupB)).toBe('token-B1')
    expect(pool.claim(groupB)).toBe('token-B2')

    // 兩個群組都已空
    expect(pool.claim(groupA)).toBeNull()
    expect(pool.claim(groupB)).toBeNull()
  })

  test('clear() → empties all groups', () => {
    const groupA = 'group-A'
    const groupB = 'group-B'

    pool.store(groupA, 'token-A')
    pool.store(groupB, 'token-B')

    // 清空所有群組
    pool.clear()

    // 兩個群組都應返回 null
    expect(pool.claim(groupA)).toBeNull()
    expect(pool.claim(groupB)).toBeNull()
  })

  test('混合過期與有效 → [expired, expired, valid] → claim skips first 2, returns valid, expired entries cleaned up', () => {
    const groupId = 'group-mixed'

    // 在 now=0 時存放 2 個過期 token
    pool.store(groupId, 'expired-1')
    pool.store(groupId, 'expired-2')

    // 時間推進 500ms（未超過 freshnessMs=1000）
    now = 500

    // 存放 1 個有效 token
    pool.store(groupId, 'valid-token')

    // 時間推進到 1001ms（前 2 個過期，第 3 個仍有效）
    now = 1001

    // claim 應跳過前 2 個過期 token，返回有效的 token
    expect(pool.claim(groupId)).toBe('valid-token')

    // 再次 claim 應返回 null（已無 token）
    expect(pool.claim(groupId)).toBeNull()
  })

  test('邊界：token 恰好在 freshnessMs 時刻 → 視為過期', () => {
    const groupId = 'group-boundary'

    // 在 now=0 時存放 token
    pool.store(groupId, 'boundary-token')

    // 時間推進恰好 freshnessMs (1000ms)
    now = 1000

    // 根據 age >= freshnessMs，應視為過期
    expect(pool.claim(groupId)).toBeNull()
  })

  test('邊界：token 在 freshnessMs-1 時刻 → 仍有效', () => {
    const groupId = 'group-boundary-valid'

    // 在 now=0 時存放 token
    pool.store(groupId, 'valid-boundary-token')

    // 時間推進到 freshnessMs-1 (999ms)
    now = 999

    // 應仍有效
    expect(pool.claim(groupId)).toBe('valid-boundary-token')
  })

  test('多次 store 和 claim 交錯 → 保持 FIFO 順序', () => {
    const groupId = 'group-interleaved'

    pool.store(groupId, 'token-1')
    pool.store(groupId, 'token-2')

    expect(pool.claim(groupId)).toBe('token-1')

    pool.store(groupId, 'token-3')
    pool.store(groupId, 'token-4')

    expect(pool.claim(groupId)).toBe('token-2')
    expect(pool.claim(groupId)).toBe('token-3')
    expect(pool.claim(groupId)).toBe('token-4')
  })
})
