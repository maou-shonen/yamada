import { describe, expect, test } from 'bun:test'

import {
  P_MAX,
  P_MIN,
  PRIOR_ALPHA,
  PRIOR_BETA,
  SIGMOID_BETA,
  calculateDecay,
  calculateShare,
  calculateTarget,
  computeProbability,
  logit,
  sigmoid,
  updateEma,
} from './frequency-math'

describe('sigmoid', () => {
  test('x = 0 時為 0.5', () => {
    expect(sigmoid(0)).toBe(0.5)
  })

  test('x = 10 時接近 1', () => {
    expect(sigmoid(10)).toBeGreaterThan(0.9999)
  })

  test('x = -10 時接近 0', () => {
    expect(sigmoid(-10)).toBeLessThan(0.0001)
  })

  test('x = 2 的值約為 0.8808', () => {
    expect(sigmoid(2)).toBeCloseTo(0.8808, 4)
  })
})

describe('logit', () => {
  test('p = 0.3 round-trip 後維持 0.3', () => {
    expect(sigmoid(logit(0.3))).toBeCloseTo(0.3, 4)
  })

  test('p = 0.8 round-trip 後維持 0.8', () => {
    expect(sigmoid(logit(0.8))).toBeCloseTo(0.8, 4)
  })

  test('p = 0 會先 clamp，不回傳 -Infinity 或 NaN', () => {
    const value = logit(0)
    expect(Number.isFinite(value)).toBeTrue()
    expect(Number.isNaN(value)).toBeFalse()
  })

  test('p = 1 會先 clamp，不回傳 Infinity 或 NaN', () => {
    const value = logit(1)
    expect(Number.isFinite(value)).toBeTrue()
    expect(Number.isNaN(value)).toBeFalse()
  })
})

describe('calculateDecay', () => {
  test('半衰期後衰減為 0.5', () => {
    expect(calculateDecay(1000, 1000)).toBeCloseTo(0.5, 4)
  })

  test('elapsed = 0 時不衰減', () => {
    expect(calculateDecay(0, 1000)).toBeCloseTo(1, 4)
  })

  test('兩個半衰期後為 0.25', () => {
    expect(calculateDecay(2000, 1000)).toBeCloseTo(0.25, 4)
  })
})

describe('updateEma', () => {
  test('decay = 0.5 時取 current/observation 平均', () => {
    expect(updateEma(10, 1, 0.5)).toBeCloseTo(5.5, 4)
  })

  test('decay = 0 時完全使用 observation', () => {
    expect(updateEma(0, 5, 0)).toBeCloseTo(5, 4)
  })

  test('current 與 observation 相同時結果不變', () => {
    expect(updateEma(10, 10, 0.9)).toBeCloseTo(10, 4)
  })
})

describe('calculateTarget', () => {
  test('activeMembers = 1 時目標份額為 1（一對一必回）', () => {
    expect(calculateTarget(1)).toBeCloseTo(1, 4)
  })

  test('activeMembers = 4 時目標份額為 1/4', () => {
    expect(calculateTarget(4)).toBeCloseTo(0.25, 4)
  })

  test('activeMembers = 0 時目標份額為 1', () => {
    expect(calculateTarget(0)).toBeCloseTo(1, 4)
  })

  test('activeMembers = 10 時目標份額為 1/10', () => {
    expect(calculateTarget(10)).toBeCloseTo(0.1, 4)
  })

  test('minTarget 地板：activeMembers = 20 + minTarget = 0.1 → 0.1', () => {
    expect(calculateTarget(20, 0.1)).toBeCloseTo(0.1, 4)
  })

  test('minTarget 不影響小群組：activeMembers = 5 + minTarget = 0.1 → 0.2', () => {
    expect(calculateTarget(5, 0.1)).toBeCloseTo(0.2, 4)
  })

  test('minTarget = 0 時無下限', () => {
    expect(calculateTarget(100, 0)).toBeCloseTo(0.01, 4)
  })
})

describe('calculateShare', () => {
  test('cold start: (0 + 2) / (0 + 2 + 3) = 0.4', () => {
    expect(calculateShare(0, 0, PRIOR_ALPHA, PRIOR_BETA)).toBeCloseTo(0.4, 4)
  })

  test('botWeight = totalWeight = 10 時份額約 0.8', () => {
    expect(calculateShare(10, 10, PRIOR_ALPHA, PRIOR_BETA)).toBeCloseTo(0.8, 4)
  })

  test('botWeight = 0, totalWeight = 10 時份額約 0.1333', () => {
    expect(calculateShare(0, 10, PRIOR_ALPHA, PRIOR_BETA)).toBeCloseTo(0.1333, 4)
  })
})

describe('computeProbability', () => {
  test('share = target 時機率為 0.5', () => {
    expect(computeProbability(0.2, 0.2, SIGMOID_BETA, P_MIN, P_MAX)).toBeCloseTo(0.5, 4)
  })

  test('share 低於 target 時機率提高', () => {
    expect(computeProbability(0.2, 0.05, SIGMOID_BETA, P_MIN, P_MAX)).toBeGreaterThan(0.7)
  })

  test('share 高於 target 時機率降低', () => {
    expect(computeProbability(0.2, 0.5, SIGMOID_BETA, P_MIN, P_MAX)).toBeLessThan(0.3)
  })

  test('超極端輸入也會被 clamp 在 [pMin, pMax]', () => {
    const minClamped = computeProbability(1e-7, 1 - 1e-7, 10, P_MIN, P_MAX)
    const maxClamped = computeProbability(1 - 1e-7, 1e-7, 10, P_MIN, P_MAX)

    expect(minClamped).toBeGreaterThanOrEqual(P_MIN)
    expect(minClamped).toBeLessThanOrEqual(P_MAX)
    expect(maxClamped).toBeGreaterThanOrEqual(P_MIN)
    expect(maxClamped).toBeLessThanOrEqual(P_MAX)
  })
})
