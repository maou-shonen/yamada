import type { Database } from 'bun:sqlite'
import type { Agent } from '../agent/index.ts'
import { log } from '../logger'
import {
  claimDueTriggers,
  completeTrigger,
  recoverStaleTriggers,
} from './trigger-store'

type TriggerPlatform = 'discord' | 'line'

interface SchedulerConfig {
  SCHEDULER_POLL_INTERVAL_MS: number
  DEBOUNCE_SILENCE_MS: number
  DEBOUNCE_URGENT_MS: number
  DEBOUNCE_OVERFLOW_CHARS: number
}

interface SchedulerTriggerStore {
  claimDueTriggers: typeof claimDueTriggers
  completeTrigger: typeof completeTrigger
  recoverStaleTriggers: typeof recoverStaleTriggers
}

export interface SchedulerDeps {
  sqlite: Database
  getAgent: (groupId: string) => Agent | undefined
  config: SchedulerConfig
  triggerStore?: SchedulerTriggerStore
}

export interface Scheduler {
  start: () => void
  stop: () => Promise<void>
}

const schedulerLog = log.withPrefix('[Scheduler]')

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const triggerStore = deps.triggerStore ?? {
    claimDueTriggers,
    completeTrigger,
    recoverStaleTriggers,
  }

  let intervalId: ReturnType<typeof setInterval> | null = null
  let recoveredStaleTriggers = false
  let inFlightTick: Promise<void> | null = null

  const tick = async (): Promise<void> => {
    if (inFlightTick) {
      return
    }

    const runningTick = (async () => {
      try {
        if (!recoveredStaleTriggers) {
          recoveredStaleTriggers = true
          triggerStore.recoverStaleTriggers(deps.sqlite)
        }

        const claimedTriggers = triggerStore.claimDueTriggers(deps.sqlite, Date.now())

        for (const trigger of claimedTriggers) {
          try {
            const agent = deps.getAgent(trigger.groupId)
            if (agent) {
              await agent.processTriggeredMessages(trigger.platform as TriggerPlatform)
            }
          }
          catch (error) {
            schedulerLog.withError(error).error('Failed to process claimed trigger')
          }
          finally {
            triggerStore.completeTrigger(deps.sqlite, trigger.groupId)
          }
        }
      }
      catch (error) {
        schedulerLog.withError(error).error('Scheduler tick failed')
      }
    })()

    inFlightTick = runningTick
    try {
      await runningTick
    }
    finally {
      inFlightTick = null
    }
  }

  return {
    start(): void {
      if (intervalId) {
        return
      }

      intervalId = setInterval(() => {
        void tick()
      }, deps.config.SCHEDULER_POLL_INTERVAL_MS)
    },

    async stop(): Promise<void> {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }

      if (inFlightTick) {
        await inFlightTick
      }
    },
  }
}
