import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { notifyAutomationStateChanged } from 'src/utils/sessionState.js'
import { SLEEP_TOOL_NAME, DESCRIPTION, SLEEP_TOOL_PROMPT } from './prompt.js'

const SLEEP_WAKE_CHECK_INTERVAL_MS = 500

const inputSchema = lazySchema(() =>
  z.strictObject({
    duration_seconds: z
      .number()
      .describe(
        'How long to sleep in seconds. Can be interrupted by the user at any time.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type SleepInput = z.infer<InputSchema>

type SleepOutput = { slept_seconds: number; interrupted: boolean }

function isProactiveAutomationEnabled(): boolean {
  if (!(feature('PROACTIVE') || feature('KAIROS'))) {
    return false
  }

  const mod =
    require('src/proactive/index.js') as typeof import('src/proactive/index.js')
  return mod.isProactiveActive()
}

// Pure decision, exported for tests: sleep is withheld only when the user has
// paused an ACTIVE autonomous session (they pressed Esc and expect control
// back). A normal session (never activated) or an active-but-unpaused one may
// sleep.
export function proactiveSleepBlocked(
  active: boolean,
  paused: boolean,
): boolean {
  return active && paused
}

function isProactiveSleepAllowed(): boolean {
  if (!(feature('PROACTIVE') || feature('KAIROS'))) {
    return true
  }

  const mod =
    require('src/proactive/index.js') as typeof import('src/proactive/index.js')
  return !proactiveSleepBlocked(
    mod.isProactiveActive(),
    mod.isProactivePaused(),
  )
}

function getQueueLength(): number {
  const queue =
    require('src/utils/messageQueueManager.js') as typeof import('src/utils/messageQueueManager.js')
  return queue.getCommandQueue().length
}

function hasNewQueuedWork(baseline: number): boolean {
  return getQueueLength() > baseline
}

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  searchHint: 'wait pause sleep rest idle duration timer',
  maxResultSizeChars: 1_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SLEEP_TOOL_PROMPT
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },

  userFacingName() {
    return SLEEP_TOOL_NAME
  },

  renderToolUseMessage(input: Partial<SleepInput>) {
    const secs = input.duration_seconds ?? '?'
    return `Sleep: ${secs}s`
  },

  mapToolResultToToolResultBlockParam(
    content: SleepOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    const msg = content.interrupted
      ? `Sleep interrupted after ${content.slept_seconds}s`
      : `Slept for ${content.slept_seconds}s`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: msg,
    }
  },

  async call(input: SleepInput, context) {
    // Don't enter sleep if proactive automation was disabled while the model
    // was deciding to wait. A non-empty command queue does NOT cancel the
    // sleep: work that was already queued is processed on the next turn, and
    // only NEW work arriving mid-sleep wakes it early.
    if (!isProactiveSleepAllowed()) {
      return {
        data: {
          slept_seconds: 0,
          interrupted: true,
        },
      }
    }

    const { duration_seconds } = input
    const startTime = Date.now()
    const sleepUntil = startTime + duration_seconds * 1000
    const queueBaseline = getQueueLength()

    if (isProactiveAutomationEnabled()) {
      notifyAutomationStateChanged({
        enabled: true,
        phase: 'sleeping',
        next_tick_at: null,
        sleep_until: sleepUntil,
      })
    }

    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const unsubscribes: Array<() => void> = []
        let settled = false

        const cleanup = () => {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          for (const unsubscribe of unsubscribes.splice(0)) {
            unsubscribe()
          }
          context.abortController.signal.removeEventListener('abort', onAbort)
        }

        const finish = () => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }

        const interrupt = () => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error('interrupted'))
        }

        const onAbort = () => {
          interrupt()
        }

        timer = setTimeout(finish, duration_seconds * 1000)

        // Abort via user interrupt
        if (context.abortController.signal.aborted) {
          interrupt()
          return
        }
        context.abortController.signal.addEventListener('abort', onAbort, {
          once: true,
        })

        // Wake instantly when new work lands in the shared command queue
        // after the sleep started, or proactive automation is disabled
        // mid-sleep. Optional-call: test mocks of these modules may lack
        // the subscribe exports.
        const queue =
          require('src/utils/messageQueueManager.js') as typeof import('src/utils/messageQueueManager.js')
        const queueUnsub = queue.subscribeToCommandQueue?.(() => {
          if (hasNewQueuedWork(queueBaseline)) interrupt()
        })
        if (queueUnsub) {
          unsubscribes.push(queueUnsub)
        }

        if (isProactiveAutomationEnabled()) {
          const proactive =
            require('src/proactive/index.js') as typeof import('src/proactive/index.js')
          const proactiveUnsub = proactive.subscribeToProactiveChanges?.(() => {
            if (!isProactiveSleepAllowed()) interrupt()
          })
          if (proactiveUnsub) {
            unsubscribes.push(proactiveUnsub)
          }
        }

        // Fallback poll in case a change signal never fires (e.g. a test
        // mock of the queue module without event support).
        let wakeCheck: ReturnType<typeof setInterval> | null = null
        wakeCheck = setInterval(() => {
          if (!isProactiveSleepAllowed() || hasNewQueuedWork(queueBaseline)) {
            interrupt()
          }
        }, SLEEP_WAKE_CHECK_INTERVAL_MS)
        unsubscribes.push(() => {
          if (wakeCheck !== null) {
            clearInterval(wakeCheck)
            wakeCheck = null
          }
        })
      })
      return {
        data: {
          slept_seconds: duration_seconds,
          interrupted: false,
        },
      }
    } catch {
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      return {
        data: {
          slept_seconds: elapsed,
          interrupted: true,
        },
      }
    } finally {
      notifyAutomationStateChanged(
        isProactiveAutomationEnabled()
          ? {
              enabled: true,
              phase: null,
              next_tick_at: null,
              sleep_until: null,
            }
          : null,
      )
    }
  },
})
