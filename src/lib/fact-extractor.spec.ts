import type { Config } from '../config/index.ts'
import type { FactExtractorDeps } from './fact-extractor'
import { describe, expect, test } from 'bun:test'
import { createTestConfig } from '../__tests__/helpers/config.ts'
import { extractFacts } from './fact-extractor'
import { createUserMask } from './alias-replacer'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return createTestConfig({
    OBSERVER_MODEL: 'openai/gpt-4o-mini',
    ...overrides,
  })
}

function createFakeDeps(overrides: Partial<FactExtractorDeps> = {}): Partial<FactExtractorDeps> {
  return {
    generateObject: (async () => ({ object: [] })) as unknown as FactExtractorDeps['generateObject'],
    generateWithFallback: (async () => '[]') as unknown as FactExtractorDeps['generateWithFallback'],
    createModel: (() => ({})) as unknown as FactExtractorDeps['createModel'],
    ...overrides,
  }
}

describe('extractFacts', () => {
  test('空訊息 → 回傳 []', async () => {
    const config = makeConfig()
    const result = await extractFacts([], [], config, undefined, createFakeDeps())
    expect(result).toEqual([])
  })

  test('正常抽取：generateObject 成功回傳事實', async () => {
    const config = makeConfig()
    const deps = createFakeDeps({
      generateObject: (async () => ({
        object: [{
          action: 'insert',
          scope: 'user',
          userId: 'alice',
          canonicalKey: 'pet_preference',
          content: 'Alice 養了一隻貓',
          confidence: 0.9,
        }],
      })) as unknown as FactExtractorDeps['generateObject'],
    })

    const result = await extractFacts(
      [{ userId: 'alice', userName: 'Alice', content: '我養了一隻貓', createdAt: Date.now() }],
      [],
      config,
      undefined,
      deps,
    )

    expect(result.length).toBe(1)
    expect(result[0]).toMatchObject({
      action: 'insert',
      scope: 'user',
      userId: 'alice',
      canonicalKey: 'pet_preference',
      content: 'Alice 養了一隻貓',
      confidence: 0.9,
    })
  })

  test('canonical_key 正規化：空格轉底線、大寫轉小寫', async () => {
    const config = makeConfig()
    const deps = createFakeDeps({
      generateObject: (async () => ({
        object: [{
          action: 'insert',
          scope: 'user',
          userId: 'alice',
          canonicalKey: 'Pet Preference',
          content: 'Alice 養了一隻貓',
          confidence: 0.9,
        }],
      })) as unknown as FactExtractorDeps['generateObject'],
    })

    const result = await extractFacts(
      [{ userId: 'alice', userName: 'Alice', content: '我養了一隻貓', createdAt: Date.now() }],
      [],
      config,
      undefined,
      deps,
    )

    expect(result[0].canonicalKey).toBe('pet_preference')
  })

  test('generateObject fallback：generateObject 拋錯 → generateWithFallback 接手', async () => {
    const config = makeConfig()
    const deps = createFakeDeps({
      generateObject: (async () => { throw new Error('API error') }) as unknown as FactExtractorDeps['generateObject'],
      generateWithFallback: (async () => JSON.stringify([{
        action: 'insert',
        scope: 'group',
        canonicalKey: 'group_tradition',
        content: '每週五聚餐',
        confidence: 0.8,
      }])) as unknown as FactExtractorDeps['generateWithFallback'],
    })

    const result = await extractFacts(
      [{ userId: 'alice', userName: 'Alice', content: '我們每週五聚餐', createdAt: Date.now() }],
      [],
      config,
      undefined,
      deps,
    )

    expect(result.length).toBe(1)
    expect(result[0]).toMatchObject({
      scope: 'group',
      canonicalKey: 'group_tradition',
      content: '每週五聚餐',
      confidence: 0.8,
    })
    // group scope 不應有 userId
    expect(result[0].userId).toBeUndefined()
  })

  test('confidence 超出範圍 → 被過濾', async () => {
    const config = makeConfig()
    const deps = createFakeDeps({
      generateObject: (async () => ({
        object: [{
          action: 'insert',
          scope: 'user',
          userId: 'alice',
          canonicalKey: 'pet_preference',
          content: 'Alice 養了一隻貓',
          confidence: 1.5,
        }],
      })) as unknown as FactExtractorDeps['generateObject'],
    })

    const result = await extractFacts(
      [{ userId: 'alice', userName: 'Alice', content: '我養了一隻貓', createdAt: Date.now() }],
      [],
      config,
      undefined,
      deps,
    )

    expect(result.length).toBe(0)
  })

  test('userId 掩碼：LLM 回傳 alias → unmask 為原始 userId', async () => {
    const config = makeConfig()
    const userMask = createUserMask(new Map([
      ['discord:123', { alias: 'user_bright_owl', userName: 'Alice' }],
    ]))
    const deps = createFakeDeps({
      generateObject: (async () => ({
        object: [{
          action: 'insert',
          scope: 'user',
          userId: 'user_bright_owl',
          canonicalKey: 'pet_preference',
          content: '喜歡貓',
          confidence: 0.95,
        }],
      })) as unknown as FactExtractorDeps['generateObject'],
    })

    const result = await extractFacts(
      [{ userId: 'user_bright_owl', userName: 'user_bright_owl', content: '我喜歡貓', createdAt: Date.now() }],
      [],
      config,
      userMask,
      deps,
    )

    expect(result).toEqual([
      {
        action: 'insert',
        scope: 'user',
        userId: 'discord:123',
        canonicalKey: 'pet_preference',
        content: '喜歡貓',
        confidence: 0.95,
      },
    ])
  })
})
