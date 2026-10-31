type TimedImage = { status: string; queued_at?: number | null; started?: number | null; finished?: number | null }
type TimedTask = { status: string; created: number; updated: number; images: TimedImage[] }
const activeImages = new Set(['generating', 'uploading'])

export function formatDuration(milliseconds: number | null) {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—'
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  if (seconds < 1) return '<1秒'
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60 ? `${seconds % 60}秒` : ''}`
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分`
}
export function imageTiming(image: TimedImage, task: Pick<TimedTask, 'created' | 'updated'>, now: number) {
  const queued = image.status === 'queued'
  const started = queued ? null : image.started
  const end = image.finished ?? (activeImages.has(image.status) ? now : null)
  return {
    waiting: Math.max(0, (started ?? (queued ? now : image.finished ?? task.updated)) - (image.queued_at ?? task.created)),
    processing: started != null && end != null ? Math.max(0, end - started) : null,
  }
}
export function taskTiming(task: TimedTask, now: number) {
  const live = ['queued', 'running'].includes(task.status) || task.images.some(image => activeImages.has(image.status))
  const end = live ? now : Math.max(task.updated, ...task.images.map(image => image.finished ?? task.created))
  const completed = task.images.filter(image => ['success', 'error'].includes(image.status)).map(image => imageTiming(image, task, now).processing).filter((value): value is number => value !== null)
  return { total: Math.max(0, end - task.created), average: completed.length ? completed.reduce((sum, value) => sum + value, 0) / completed.length : null }
}
