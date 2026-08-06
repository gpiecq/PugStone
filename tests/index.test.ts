import { describe, it, expect, vi } from 'vitest'
import { startLoop } from '../src/index.js'

describe('startLoop', () => {
  it('poursuit ses itérations après une erreur', async () => {
    vi.useFakeTimers()
    const task = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)

    const loop = startLoop('test', 1000, task)
    await vi.advanceTimersByTimeAsync(3500)
    loop.stop()

    expect(task.mock.calls.length).toBeGreaterThanOrEqual(3)
    vi.useRealTimers()
  })

  it('cesse d\'appeler la tâche après stop()', async () => {
    vi.useFakeTimers()
    const task = vi.fn().mockResolvedValue(undefined)
    const loop = startLoop('test', 1000, task)
    await vi.advanceTimersByTimeAsync(1500)
    loop.stop()
    const callsAtStop = task.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(task.mock.calls.length).toBe(callsAtStop)
    vi.useRealTimers()
  })
})
