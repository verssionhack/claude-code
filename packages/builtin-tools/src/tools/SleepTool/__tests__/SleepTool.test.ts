import { beforeEach, describe, expect, test } from 'bun:test'
import { SleepTool } from '../SleepTool'
import {
  enqueue,
  getCommandQueue,
  resetCommandQueue,
} from 'src/utils/messageQueueManager.js'

describe('SleepTool', () => {
  beforeEach(() => {
    resetCommandQueue()
  })

  test('declares cancel interrupt behavior', () => {
    expect(SleepTool.interruptBehavior()).toBe('cancel')
  })

  test('wakes early when queued work arrives', async () => {
    const sleepPromise = SleepTool.call({ duration_seconds: 10 }, {
      abortController: new AbortController(),
    } as any)

    setTimeout(() => {
      enqueue({
        value: 'wake up',
        mode: 'prompt',
      })
    }, 20)

    const wakeStartedAt = Date.now()
    const result = await sleepPromise
    const wakeLatencyMs = Date.now() - wakeStartedAt

    expect(result.data.interrupted).toBe(true)
    expect(result.data.slept_seconds).toBeLessThan(10)
    // Wake-up must come from the queue-change subscription (or the 500ms
    // fallback poll), never from the full sleep duration.
    expect(wakeLatencyMs).toBeLessThan(1000)
    expect(getCommandQueue()).toHaveLength(1)
    expect(getCommandQueue()[0]).toMatchObject({
      value: 'wake up',
      mode: 'prompt',
    })
  })

  test('sleeps the full duration when nothing is queued', async () => {
    const result = await SleepTool.call({ duration_seconds: 0.3 }, {
      abortController: new AbortController(),
    } as any)

    expect(result.data.interrupted).toBe(false)
    expect(result.data.slept_seconds).toBe(0.3)
  })

  test('ignores work already queued when the sleep starts', async () => {
    enqueue({
      value: 'already queued',
      mode: 'prompt',
    })

    const result = await SleepTool.call({ duration_seconds: 0.3 }, {
      abortController: new AbortController(),
    } as any)

    expect(result.data.interrupted).toBe(false)
    expect(result.data.slept_seconds).toBe(0.3)
    expect(getCommandQueue()).toHaveLength(1)
  })

  test('wakes when new work arrives on top of pre-existing queued work', async () => {
    enqueue({
      value: 'old work',
      mode: 'prompt',
    })

    const sleepPromise = SleepTool.call({ duration_seconds: 10 }, {
      abortController: new AbortController(),
    } as any)

    setTimeout(() => {
      enqueue({
        value: 'new work',
        mode: 'prompt',
      })
    }, 20)

    const result = await sleepPromise

    expect(result.data.interrupted).toBe(true)
    expect(result.data.slept_seconds).toBeLessThan(10)
    expect(getCommandQueue()).toHaveLength(2)
  })

  test('wakes when pre-existing queued work is cleared and new work arrives (same queue length)', async () => {
    enqueue({
      value: 'old work',
      mode: 'prompt',
    })

    const sleepPromise = SleepTool.call({ duration_seconds: 10 }, {
      abortController: new AbortController(),
    } as any)

    setTimeout(() => {
      resetCommandQueue()
      enqueue({
        value: 'replacement new work',
        mode: 'prompt',
      })
    }, 20)

    const result = await sleepPromise

    expect(result.data.interrupted).toBe(true)
    expect(result.data.slept_seconds).toBeLessThan(10)
    expect(getCommandQueue()).toHaveLength(1)
  })
})
