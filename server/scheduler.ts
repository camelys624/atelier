import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { db, dataDir, settings, accounts, getAccount, getTask, taskImages, id, hash, type Account, type ImageRow, type Task } from './store'
import { generateImage, refreshAccount, safeError } from './adapter'
import { fetchReference } from './network'
import { persistImage, cleanupUploadedFile } from './storage'
import { accountSource, isUploadedReference, uploadedReference } from './image-input'
import { CODEX_IMAGE_PLANS, needsAccountRefresh } from './account-policy'

mkdirSync(resolve(dataDir, 'spool'), { recursive: true, mode: 0o700 })
const running = new Set<string>()
const refreshing = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined
let stopped = false
export const baseUrl = () => (process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3080}`).replace(/\/$/, '')
export function updateTaskStatus(taskId: string) {
  const task = getTask(taskId)
  if (!task || task.status === 'cancelled') return
  const rows = taskImages(taskId)
  const success = rows.filter(i => i.status === 'success').length
  const pending = rows.some(i => ['queued', 'generating', 'uploading'].includes(i.status))
  const active = rows.some(i => ['generating', 'uploading'].includes(i.status))
  const status = pending ? (active ? 'running' : 'queued') : success === rows.length ? 'success' : success ? 'partial' : 'error'
  db.run('UPDATE tasks SET status=?,updated=? WHERE id=?', [status, Date.now(), taskId])
}
type TaskInput = { owner: string; prompt: string; model: string; n: number; refs: string[]; size?: string; quality?: string; demo?: boolean; clientId?: string }
export function taskFingerprint(input: Omit<TaskInput, 'owner'>) {
  const values: unknown[] = [input.prompt, input.model, input.n, input.refs, !!input.demo]
  // Preserve fingerprints of requests submitted before size/quality were supported.
  if ((input.size || '1024x1024') !== '1024x1024' || (input.quality || 'auto') !== 'auto') values.push(input.size || '1024x1024', input.quality || 'auto')
  return hash(JSON.stringify(values))
}
export function submitTask(input: TaskInput) {
  const fingerprint = taskFingerprint(input)
  return db.transaction(() => {
    if (input.clientId) {
      const existing = db.query<Task, [string, string]>('SELECT * FROM tasks WHERE owner=? AND client_id=?').get(input.owner, input.clientId)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('这个幂等标识已用于不同请求，请使用新的标识')
        return existing
      }
    }
    const queued = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM images WHERE status IN ('queued','generating','uploading')").get()!.count
    if (queued + input.n > settings().queueLimit) throw new Error('队列已满，请稍后重试')
    const taskId = id('task'), now = Date.now()
    db.run('INSERT INTO tasks(id,owner,client_id,fingerprint,prompt,model,n,refs,demo,created,updated,size,quality) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [taskId, input.owner, input.clientId || null, fingerprint, input.prompt, input.model, input.n, JSON.stringify(input.refs), input.demo ? 1 : 0, now, now, input.size || '1024x1024', input.quality || 'auto'])
    for (let i = 0; i < input.n; i++) db.run('INSERT INTO images(id,task_id,position,queued_at) VALUES(?,?,?,?)', [id('img'), taskId, i, now])
    return getTask(taskId)!
  }).immediate()
}
export function claimImage(): { image: ImageRow; task: Task; account: Account | null } | null {
  return db.transaction(() => {
    const options = settings()
    const active = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM images WHERE status IN ('generating','uploading')").get()!.count
    if (active >= options.globalConcurrency) return null
    const candidates = db.query<ImageRow, []>("SELECT i.* FROM images i JOIN tasks t ON t.id=i.task_id WHERE i.status='queued' AND t.status IN ('queued','running') ORDER BY t.created,t.rowid,i.position LIMIT 500").all()
    for (const image of candidates) {
      const task = getTask(image.task_id)!
      const busy = db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM images WHERE task_id=? AND status IN ('generating','uploading')").get(task.id)!.count
      if (busy >= options.taskConcurrency) continue
      let account: Account | null = null
      if (!task.demo) {
        const source = accountSource(task.model)
        // Least-loaded first (inflight relative to slots), then least recently used, so work spreads before any account stacks up.
        account = db.query<Account, [string, number, ...string[]]>(`SELECT * FROM accounts WHERE source=? AND status='ready' AND inflight<slots AND (quota IS NULL OR quota>inflight) AND cooldown_until<=? AND (source!='codex' OR lower(trim(plan)) IN (${CODEX_IMAGE_PLANS.map(() => '?').join(',')})) ORDER BY CAST(inflight AS REAL)/slots,inflight,last_used,created LIMIT 1`).get(source, Date.now(), ...CODEX_IMAGE_PLANS)
        if (!account) continue
        db.run('UPDATE accounts SET inflight=inflight+1,last_used=? WHERE id=?', [Date.now(), account.id])
      }
      db.run("UPDATE images SET status='generating',account_id=?,attempts=attempts+1,started=?,error=NULL WHERE id=?", [account?.id || null, Date.now(), image.id])
      db.run("UPDATE tasks SET status='running',updated=? WHERE id=?", [Date.now(), task.id])
      return { image: { ...image, status: 'generating' }, task, account }
    }
    return null
  }).immediate()
}
async function demoImage(imageId: string, index: number) {
  const palettes = [['#e8e1d6', '#b58f6d', '#4d5b4b'], ['#dce5dc', '#96ad99', '#2d4a40'], ['#ece0dc', '#c0876e', '#4a3935'], ['#dce2ed', '#8d9bb3', '#333c4c']]
  const p = palettes[index % palettes.length]
  const path = resolve(dataDir, 'spool', `${imageId}.svg`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 1100"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="${p[0]}"/><stop offset="1" stop-color="${p[1]}"/></linearGradient><filter id="s"><feGaussianBlur stdDeviation="20"/></filter></defs><rect width="900" height="1100" fill="url(#a)"/><circle cx="690" cy="280" r="225" fill="${p[0]}" opacity=".65"/><ellipse cx="450" cy="880" rx="235" ry="35" fill="${p[2]}" opacity=".2" filter="url(#s)"/><rect x="300" y="360" width="300" height="480" rx="130" fill="${p[2]}"/><rect x="338" y="480" width="224" height="200" rx="4" fill="${p[0]}"/><text x="450" y="570" text-anchor="middle" fill="${p[2]}" font-family="serif" font-size="40" letter-spacing="7">ATELIER</text><text x="450" y="610" text-anchor="middle" fill="${p[2]}" font-family="sans-serif" font-size="13" letter-spacing="4">IMAGE SERVICE</text><text x="50" y="1035" fill="${p[2]}" font-family="sans-serif" font-size="17" opacity=".65">LOCAL DEMO · ${String(index + 1).padStart(2, '0')} / SYNTHETIC PREVIEW</text></svg>`
  await Bun.sleep(650 + (index % 3) * 250)
  await Bun.write(path, svg)
  return { path, mime: 'image/svg+xml', bytes: Buffer.byteLength(svg) }
}
async function upload(imageId: string) {
  const image = db.query<ImageRow, [string]>('SELECT * FROM images WHERE id=?').get(imageId)!
  // Demo previews stay local and never pretend to test OSS credentials.
  const task = getTask(image.task_id)!
  const result = task.demo ? { url: `${baseUrl()}/media/${imageId}`, key: '' } : await persistImage(image, baseUrl())
  db.run("UPDATE images SET status='success',url=?,object_key=?,finished=?,error=NULL WHERE id=?", [result.url, result.key || null, Date.now(), image.id])
  if (!task.demo) await cleanupUploadedFile(image)
}
async function execute(job: NonNullable<ReturnType<typeof claimImage>>) {
  const { image, account, task } = job
  let slotReleased = false
  try {
    const refs: string[] = []
    if (!task.demo) for (const reference of JSON.parse(task.refs)) refs.push(await (isUploadedReference(reference) ? uploadedReference(reference) : fetchReference(reference)))
    const result = task.demo ? await demoImage(image.id, image.position) : await generateImage(account!, { prompt: task.prompt, model: task.model, size: task.size, quality: task.quality, images: refs, imageId: image.id })
    db.transaction(() => {
      db.run("UPDATE images SET status='uploading',local_path=?,mime=?,bytes=? WHERE id=?", [result.path, result.mime, result.bytes, image.id])
      if (account) db.run("UPDATE accounts SET inflight=MAX(0,inflight-1),success=success+1,quota=CASE WHEN quota IS NULL THEN NULL ELSE MAX(0,quota-1) END,status=CASE WHEN status='disabled' THEN 'disabled' WHEN quota=1 THEN 'limited' ELSE status END WHERE id=?", [account.id])
    }).immediate()
    slotReleased = true
    await upload(image.id)
  } catch (error) {
    const message = safeError(error)
    db.run("UPDATE images SET status='error',error=?,finished=? WHERE id=?", [message, Date.now(), image.id])
    if (account && !slotReleased) db.run('UPDATE accounts SET inflight=MAX(0,inflight-1),fail=fail+1,cooldown_until=?,last_error=? WHERE id=?', [Date.now() + 60_000, message, account.id])
  } finally {
    running.delete(image.id)
    updateTaskStatus(task.id)
    void pump()
  }
}
let pumping = false
export async function pump() {
  if (pumping || stopped) return
  pumping = true
  try {
    // Recover uploads separately: a persisted result must never be regenerated.
    for (const image of db.query<ImageRow, []>("SELECT * FROM images WHERE status='uploading'").all()) {
      if (running.size >= settings().globalConcurrency) break
      if (running.has(image.id)) continue
      running.add(image.id)
      void upload(image.id).catch(error => db.run("UPDATE images SET status='error',error=?,finished=? WHERE id=?", [safeError(error), Date.now(), image.id])).finally(() => { running.delete(image.id); updateTaskStatus(image.task_id) })
    }
    while (running.size < settings().globalConcurrency) {
      const job = claimImage()
      if (!job) break
      running.add(job.image.id)
      void execute(job)
    }
    for (const task of db.query<Task, []>("SELECT * FROM tasks WHERE status IN ('queued','running')").all()) updateTaskStatus(task.id)
  } finally { pumping = false }
}
export function retryTask(taskId: string) {
  if (getTask(taskId)?.status === 'cancelled') throw new Error('已取消的任务无法重试，请新建任务')
  const failed = taskImages(taskId).filter(i => i.status === 'error')
  const count = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM images WHERE status IN ('queued','generating','uploading')").get()!.count
  if (count + failed.length > settings().queueLimit) throw new Error('队列已满')
  const now = Date.now()
  for (const image of failed) db.run('UPDATE images SET status=?,error=NULL,finished=NULL,queued_at=?,started=? WHERE id=?', [image.local_path ? 'uploading' : 'queued', now, image.local_path ? now : null, image.id])
  updateTaskStatus(taskId)
  void pump()
}
export function startScheduler() {
  timer = setInterval(() => void pump(), 500)
  setInterval(() => {
    const now = Date.now()
    const batch = accounts().filter(a => needsAccountRefresh(a, now, settings().refreshMinutes) && !refreshing.has(a.id)).sort((a, b) => (a.last_refresh || 0) - (b.last_refresh || 0)).slice(0, Math.max(0, 3 - refreshing.size))
    for (const account of batch) {
      refreshing.add(account.id)
      void refreshAccount(account.id).catch(() => {}).finally(() => refreshing.delete(account.id))
    }
  }, 15_000)
  void pump()
}
export function stopScheduler() { stopped = true; if (timer) clearInterval(timer) }
