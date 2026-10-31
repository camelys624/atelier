import { describe, expect, test } from 'bun:test'
import { formatDuration, imageTiming, taskTiming } from '../src/lib/timing'

describe('task and image elapsed time', () => {
  const task = { created: 1000, updated: 13000, status: 'success' }
  test('separates queue time from processing and freezes a completed image', () => {
    const image = { status: 'success', queued_at: 1000, started: 4000, finished: 13000 }
    expect(imageTiming(image, task, 99000)).toEqual({ waiting: 3000, processing: 9000 })
    expect(imageTiming({ ...image, status: 'generating', finished: null }, task, 9000).processing).toBe(5000)
  })
  test('uses the latest retry queue timestamp and does not reuse the previous attempt start', () => {
    expect(imageTiming({ status: 'queued', queued_at: 20000, started: 4000, finished: null }, task, 25000)).toEqual({ waiting: 5000, processing: null })
    expect(imageTiming({ status: 'success', queued_at: 20000, started: 22000, finished: 30000 }, task, 50000)).toEqual({ waiting: 2000, processing: 8000 })
  })
  test('does not confuse parallel task wall time with the sum of image processing times', () => {
    const images = [
      { status: 'success', started: 4000, finished: 13000 },
      { status: 'success', started: 4000, finished: 11000 },
    ]
    expect(taskTiming({ ...task, images }, 99000)).toEqual({ total: 12000, average: 8000 })
  })
  test('keeps a cancelled task clock running while an already-started image still finishes', () => {
    const cancelled = { ...task, status: 'cancelled', updated: 6000, images: [{ status: 'generating', started: 4000, finished: null }] }
    expect(taskTiming(cancelled, 10000).total).toBe(9000)
    expect(taskTiming({ ...cancelled, images: [{ status: 'success', started: 4000, finished: 15000 }] }, 99000).total).toBe(14000)
  })
  test('handles cancelled/unstarted images and old records without making up processing times', () => {
    expect(imageTiming({ status: 'cancelled', started: null, finished: 6000 }, task, 99000)).toEqual({ waiting: 5000, processing: null })
    expect(imageTiming({ status: 'success' }, task, 99000).processing).toBeNull()
    expect(taskTiming({ ...task, images: [{ status: 'success' }] }, 99000).average).toBeNull()
  })
  test('formats elapsed seconds and minute/hour boundaries', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(999)).toBe('<1秒')
    expect(formatDuration(61000)).toBe('1分1秒')
    expect(formatDuration(3600000)).toBe('1小时0分')
    expect(formatDuration(-2000)).toBe('<1秒')
  })
})
