import type { Config } from '../config/index.ts'
import type { DB } from '../storage/db'
import { log } from '../logger'
import {
  countActiveMembers,
  getFrequencyState,
  saveFrequencyState,
} from '../storage/frequency-stats'
import {
  calculateDecay,
  calculateShare,
  calculateTarget,
  computeProbability,
  P_MAX,
  P_MIN,
  PRIOR_ALPHA,
  PRIOR_BETA,
  SIGMOID_BETA,
} from './frequency-math'

export interface FrequencyMetadata {
  emaLongShare: number
  emaShortShare: number
  target: number
  activeMembers: number
  rng: number
  isMention: boolean
  reason: string
}

export interface FrequencyDecision {
  shouldRespond: boolean
  probability: number
  metadata: FrequencyMetadata
}

export interface FrequencyControllerDeps {
  getFrequencyState: typeof getFrequencyState
  saveFrequencyState: typeof saveFrequencyState
  countActiveMembers: typeof countActiveMembers
  now: () => number
  random: () => number
}

const defaultDeps: FrequencyControllerDeps = {
  getFrequencyState,
  saveFrequencyState,
  countActiveMembers,
  now: Date.now,
  random: Math.random,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function checkFrequency(
  db: DB,
  config: Config,
  isMention: boolean,
  deps: Partial<FrequencyControllerDeps> = {},
): FrequencyDecision {
  const resolvedDeps: FrequencyControllerDeps = {
    ...defaultDeps,
    ...deps,
  }

  if (!config.FREQUENCY_ENABLED) {
    const metadata: FrequencyMetadata = {
      emaLongShare: 0,
      emaShortShare: 0,
      target: 1,
      activeMembers: 0,
      rng: 0,
      isMention,
      reason: 'disabled',
    }

    return {
      shouldRespond: true,
      probability: 1,
      metadata,
    }
  }

  if (isMention) {
    const metadata: FrequencyMetadata = {
      emaLongShare: 0,
      emaShortShare: 0,
      target: 1,
      activeMembers: 0,
      rng: 0,
      isMention,
      reason: 'mention_bypass',
    }

    return {
      shouldRespond: true,
      probability: 1,
      metadata,
    }
  }

  const now = resolvedDeps.now()
  const state = resolvedDeps.getFrequencyState(db)

  const since = now - (config.FREQUENCY_ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const activeMembers = resolvedDeps.countActiveMembers(db, since)
  const target = calculateTarget(activeMembers)

  let decayLong = 1
  let decayShort = 1

  if (state) {
    const elapsed = now - state.lastUpdatedAt
    decayLong = calculateDecay(elapsed, config.FREQUENCY_LONG_HALFLIFE_HOURS * 60 * 60 * 1000)
    decayShort = calculateDecay(elapsed, config.FREQUENCY_SHORT_HALFLIFE_HOURS * 60 * 60 * 1000)
  }

  const emaLongBot = state?.emaLongBot ?? 0
  const emaLongTotal = state?.emaLongTotal ?? 0
  const emaShortBot = state?.emaShortBot ?? 0
  const emaShortTotal = state?.emaShortTotal ?? 0

  const shareLong = calculateShare(
    emaLongBot * decayLong,
    emaLongTotal * decayLong,
    PRIOR_ALPHA,
    PRIOR_BETA,
  )

  const shareShort = calculateShare(
    emaShortBot * decayShort,
    emaShortTotal * decayShort,
    PRIOR_ALPHA,
    PRIOR_BETA,
  )

  let probability = computeProbability(target, shareLong, SIGMOID_BETA, P_MIN, P_MAX)

  if (shareShort > target) {
    probability *= target / shareShort
    probability = clamp(probability, P_MIN, P_MAX)
  }

  const rng = resolvedDeps.random()
  const shouldRespond = rng < probability

  const metadata: FrequencyMetadata = {
    emaLongShare: shareLong,
    emaShortShare: shareShort,
    target,
    activeMembers,
    rng,
    isMention,
    reason: shouldRespond ? 'pass' : 'probability_gate',
  }

  log
    .withMetadata({ shouldRespond, probability, ...metadata })
    .debug('frequency_decision')

  return {
    shouldRespond,
    probability,
    metadata,
  }
}
