import { describe, expect, test } from 'bun:test'
import { generateAlias } from './alias-generator'

describe('generateAlias', () => {
  test('format matches /^user_[a-z]+_[a-z]+$/', () => {
    const alias = generateAlias(new Set())
    expect(alias).toMatch(/^user_[a-z]+_[a-z]+$/)
  })

  test('generates 100 unique aliases without collision', () => {
    const aliases = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const alias = generateAlias(aliases)
      expect(aliases.has(alias)).toBe(false)
      aliases.add(alias)
    }
    expect(aliases.size).toBe(100)
  })

  test('retries on collision and returns unique alias', () => {
    const existing = new Set<string>()
    const first = generateAlias(new Set())
    existing.add(first)
    const second = generateAlias(existing)
    expect(second).not.toBe(first)
    expect(second).toMatch(/^user_[a-z]+_[a-z]+(_\d+)?$/)
  })
})
