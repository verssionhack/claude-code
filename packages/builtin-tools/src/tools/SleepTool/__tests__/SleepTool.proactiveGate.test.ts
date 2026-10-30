import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SleepTool, proactiveSleepBlocked } from '../SleepTool'
import { activateProactive, deactivateProactive } from 'src/proactive/index.js'
import { resetCommandQueue } from 'src/utils/messageQueueManager.js'

function callSleep(seconds: number) {
  return (SleepTool as any).call({ duration_seconds: seconds }, {
    abortController: new AbortController(),
  } as any)
}

// The decision under test is a pure function of the proactive state. The
// KAIROS/PROACTIVE feature gate is compile-time only (feature() cannot be
// overridden in test mode), so the truth table lives on the pure helper
// and the end-to-end tests below cover the gate-off path with the real
// proactive module.
describe('proactiveSleepBlocked', () => {
  test('blocks sleep only when an active session is paused', () => {
    // Normal session (proactive never activated) — sleep allowed. This is
    // the reported bug: with KAIROS compiled in, a session that was never
    // activated 0s-interrupted every Sleep because the gate demanded the
    // session be active.
    expect(proactiveSleepBlocked(false, false)).toBe(false)
    // Active autonomous session, not paused — sleep allowed (that is the
    // point of Sleep in proactive mode).
    expect(proactiveSleepBlocked(true, false)).toBe(false)
    // paused is only meaningful while active — sleep allowed.
    expect(proactiveSleepBlocked(false, true)).toBe(false)
    // Paused autonomous session: the user pressed Esc and expects control
    // back — sleep withheld.
    expect(proactiveSleepBlocked(true, true)).toBe(true)
  })
})

describe('SleepTool with the real proactive module', () => {
  beforeEach(() => {
    resetCommandQueue()
    // Start every test in a clean, non-autonomous session.
    deactivateProactive()
  })

  afterEach(() => {
    deactivateProactive()
  })

  test('allows sleep in a normal (non-autonomous) session', async () => {
    const result = await callSleep(0.3)
    expect(result.data.interrupted).toBe(false)
    expect(result.data.slept_seconds).toBe(0.3)
  })

  test('allows sleep when proactive is active and unpaused', async () => {
    activateProactive('test')
    const result = await callSleep(0.3)
    expect(result.data.interrupted).toBe(false)
    expect(result.data.slept_seconds).toBe(0.3)
  })
})
