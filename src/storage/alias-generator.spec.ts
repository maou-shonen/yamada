import { describe, expect, test } from 'bun:test'
import { generateAlias } from './alias-generator'

describe('generateAlias', () => {
  test('正常格式匹配 /^user_[a-z]+_[a-z]+$/', () => {
    const alias = generateAlias(new Set())
    expect(alias).toMatch(/^user_[a-z]+_[a-z]+$/)
  })

  test('連續產生 100 個 alias 無碰撞', () => {
    const aliases = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const alias = generateAlias(aliases)
      expect(aliases.has(alias)).toBe(false)
      aliases.add(alias)
    }
    expect(aliases.size).toBe(100)
  })

  test('碰撞時 retry 成功', () => {
    // 建立一個 Set 包含大部分組合，但留一個空位
    const existing = new Set<string>()
    // 先產生一個 alias，然後把它加入 existing，再產生新的
    const first = generateAlias(new Set())
    existing.add(first)
    const second = generateAlias(existing)
    expect(second).not.toBe(first)
    expect(second).toMatch(/^user_[a-z]+_[a-z]+(_\d+)?$/)
  })

  test('50 次碰撞後 fallback 格式 /^user_[a-z]+_[a-z]+_\\d+$/', () => {
    // 建立包含所有可能 adj_noun 組合的 Set（模擬耗盡）
    // 使用已知的形容詞和名詞列表建立所有組合
    const adjs = ['amber','azure','bold','brave','bright','calm','clear','clever','cool','crisp','cyan','dark','dawn','deep','deft','dusk','eager','early','east','even','fair','fast','fine','firm','fleet','free','fresh','full','glad','gold','good','grand','gray','great','green','grey','hale','high','jade','just','keen','kind','large','late','lean','light','lively','lone','long','loud','low','lucky','mild','mint','misty','neat','new','nice','noble','north','oak','old','open','pale','pink','plain','plum','prime','proud','pure','quick','quiet','rare','red','rich','rose','round','royal','ruby','sage','salt','sandy','sharp','shiny','shy','silk','silver','slim','slow','smart','soft','solar','solid','south','still','stone','sunny','swift','tall','teal','tiny','true','warm','west','white','wide','wild','wise','young']
    const nouns = ['ant','ape','arc','ash','bay','bear','bee','bird','brook','buck','cat','cave','cedar','cliff','cloud','coral','crane','creek','crow','dawn','deer','dove','dune','eagle','elm','fern','finch','fish','fjord','flame','flock','fog','fox','frog','gale','gull','hawk','haze','hill','hive','hound','iris','isle','jay','kite','lake','lark','leaf','lion','lynx','maple','marsh','mist','moon','moss','moth','mouse','oak','orca','otter','owl','peak','pine','pond','pool','quail','rain','raven','reed','reef','ridge','river','robin','rock','rose','sage','sand','seal','shore','sky','snow','sparrow','spring','star','stone','storm','stream','sun','swan','tide','tiger','toad','trail','tree','vale','vine','vole','wave','wren','wolf']
    const allCombos = new Set<string>()
    for (const a of adjs) for (const n of nouns) allCombos.add(`user_${a}_${n}`)

    const fallback = generateAlias(allCombos)
    expect(fallback).toMatch(/^user_[a-z]+_[a-z]+_\d+$/)
  })
})
