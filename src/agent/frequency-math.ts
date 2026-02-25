const LOG_2 = Math.log(2)
const LOGIT_EPSILON = 1e-7

export const SIGMOID_BETA = 2.0
export const P_MIN = 0.05
export const P_MAX = 0.95
export const PRIOR_ALPHA = 2
export const PRIOR_BETA = 3

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 標準 sigmoid：1 / (1 + exp(-x)) */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/** Sigmoid 反函式：ln(p/(1-p))，p 自動 clamp 到 [1e-7, 1-1e-7] 防 NaN */
export function logit(p: number): number {
  const clamped = clamp(p, LOGIT_EPSILON, 1 - LOGIT_EPSILON)
  return Math.log(clamped / (1 - clamped))
}

/** EMA 時間衰減係數：exp(-elapsed * ln(2) / halfLife)
 *  elapsed = 0 → decay = 1.0（無衰減）
 *  elapsed = halfLife → decay ≈ 0.5
 */
export function calculateDecay(elapsedMs: number, halfLifeMs: number): number {
  return Math.exp((-elapsedMs * LOG_2) / halfLifeMs)
}

/** EMA 更新：current * decay + observation * (1 - decay) */
export function updateEma(current: number, observation: number, decay: number): number {
  return current * decay + observation * (1 - decay)
}

/** 公平份額：1 / (activeMembers + 1)，最小值 0（activeMembers >= 0） */
export function calculateTarget(activeMembers: number): number {
  const sanitizedActiveMembers = Math.max(activeMembers, 0)
  return 1 / (sanitizedActiveMembers + 1)
}

/** Beta prior 平滑 share：(botWeight + alpha) / (totalWeight + alpha + beta) */
export function calculateShare(
  botWeight: number,
  totalWeight: number,
  priorAlpha: number,
  priorBeta: number,
): number {
  return (botWeight + priorAlpha) / (totalWeight + priorAlpha + priorBeta)
}

/** 完整機率計算：clamp(sigmoid(beta * (logit(target) - logit(share))), pMin, pMax) */
export function computeProbability(
  target: number,
  share: number,
  beta: number,
  pMin: number,
  pMax: number,
): number {
  const score = beta * (logit(target) - logit(share))
  const probability = sigmoid(score)
  return clamp(probability, pMin, pMax)
}
