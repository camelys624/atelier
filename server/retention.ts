import { readdir, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { db, dataDir } from './store'

// The server disk is small: generated results and uploaded references stay only long enough for callers to
// fetch them. Task rows are kept so history stays visible; an expired result simply has no file any more.
const HOUR = 3_600_000
export const retentionHours = () => Math.min(24 * 30, Math.max(1, Number(process.env.IMAGE_RETENTION_HOURS) || 24))

async function removeOld(path: string, cutoff: number) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.mtimeMs >= cutoff) return 0
    await unlink(path)
    return info.size
  } catch { return 0 }
}
async function files(directory: string) {
  try { return (await readdir(directory)).map(name => ({ name, path: resolve(directory, name) })) } catch { return [] }
}

export async function cleanupImages(now = Date.now()) {
  const cutoff = now - retentionHours() * HOUR
  let results = 0, leftovers = 0, references = 0, bytes = 0
  // Finished results past retention. Clearing local_path makes a later retry regenerate instead of re-uploading.
  const expired = db.query<{ id: string; local_path: string }, [number]>("SELECT id,local_path FROM images WHERE local_path IS NOT NULL AND status IN ('success','error') AND finished < ?").all(cutoff)
  for (const image of expired) {
    try { const info = await stat(image.local_path); await unlink(image.local_path); bytes += info.size } catch {}
    db.run('UPDATE images SET local_path=NULL WHERE id=?', [image.id])
    results++
  }
  // Spool files no image points to: earlier attempts and downloaded references that outlived their attempt.
  const live = new Set(db.query<{ local_path: string }, []>('SELECT local_path FROM images WHERE local_path IS NOT NULL').all().map(r => r.local_path))
  for (const file of await files(resolve(dataDir, 'spool'))) {
    if (live.has(file.path)) continue
    const size = await removeOld(file.path, cutoff)
    if (size) { leftovers++; bytes += size }
  }
  // Uploaded references, unless a task that has not finished still needs them.
  const pending = new Set(db.query<{ refs: string }, []>("SELECT refs FROM tasks WHERE status IN ('queued','running')").all().flatMap(t => JSON.parse(t.refs) as string[]))
  for (const file of await files(resolve(dataDir, 'references'))) {
    if (pending.has(`upload:${file.name}`)) continue
    const size = await removeOld(file.path, cutoff)
    if (size) { references++; bytes += size }
  }
  if (results || leftovers || references) console.log(JSON.stringify({ event: 'image_cleanup', time: new Date(now).toISOString(), retentionHours: retentionHours(), results, leftovers, references, bytes }))
  return { results, leftovers, references, bytes }
}

let timer: ReturnType<typeof setInterval> | undefined
export function startCleanup() {
  const run = () => void cleanupImages().catch(error => console.warn(JSON.stringify({ event: 'image_cleanup_failed', time: new Date().toISOString(), message: String(error?.message || error) })))
  run()
  timer = setInterval(run, HOUR)
}
export function stopCleanup() { if (timer) clearInterval(timer) }
