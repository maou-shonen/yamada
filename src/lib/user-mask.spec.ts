import { describe, expect, test } from 'bun:test'
import { createUserMask } from './user-mask'

describe('UserMask', () => {
  test('mask：已知 userId 轉 alias；未知 userId 回傳原值', () => {
    const mask = createUserMask(new Map([
      ['discord:123', { alias: 'user_bright_owl', userName: 'Alice' }],
    ]))

    expect(mask.mask('discord:123')).toBe('user_bright_owl')
    expect(mask.mask('discord:999')).toBe('discord:999')
  })

  test('unmask：已知 alias 轉 userId；未知 alias 回傳原值', () => {
    const mask = createUserMask(new Map([
      ['discord:123', { alias: 'user_bright_owl', userName: 'Alice' }],
    ]))

    expect(mask.unmask('user_bright_owl')).toBe('discord:123')
    expect(mask.unmask('user_calm_fox')).toBe('user_calm_fox')
  })

  test('mask + unmask roundtrip：可回復原始 userId', () => {
    const mask = createUserMask(new Map([
      ['discord:123', { alias: 'user_bright_owl', userName: 'Alice' }],
    ]))

    expect(mask.unmask(mask.mask('discord:123'))).toBe('discord:123')
  })

  test('空 aliasMap：雙向皆回傳原值', () => {
    const mask = createUserMask(new Map())

    expect(mask.mask('discord:123')).toBe('discord:123')
    expect(mask.unmask('user_bright_owl')).toBe('user_bright_owl')
  })
})
