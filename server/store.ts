import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

process.umask(0o077)
export const dataDir = resolve(process.env.DATA_DIR || './data')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
export const adminKey = process.env.ADMIN_KEY || ''
const master = process.env.MASTER_KEY || ''
if (adminKey.length < 24 || !/^[a-f0-9]{64}$/i.test(master)) throw new Error('请先运行 bun run setup，或设置 ADMIN_KEY 和 MASTER_KEY。')
const encryptionKey = Buffer.from(master, 'hex')
export const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)))
export const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`
export function seal(value: unknown) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}
export function unseal<T = any>(value: string): T {
  const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString())
}
export const db = new Database(resolve(dataDir, 'atelier.sqlite'), { create: true, strict: true })
db.run('PRAGMA journal_mode=WAL')
db.run('PRAGMA foreign_keys=ON')
db.run('PRAGMA busy_timeout=5000')
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT, source TEXT NOT NULL,
 plan TEXT NOT NULL DEFAULT 'unknown', status TEXT NOT NULL DEFAULT 'pending', quota INTEGER,
 slots INTEGER NOT NULL DEFAULT 1, inflight INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0,
 fail INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0, last_error TEXT,
 last_refresh INTEGER, last_used INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, secret TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, last_used INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS device_authorizations (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
 expires INTEGER NOT NULL, next_poll INTEGER NOT NULL, interval INTEGER NOT NULL,
 secret TEXT NOT NULL, error TEXT, account_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_auth_owner ON device_authorizations(owner,created);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT, fingerprint TEXT NOT NULL, prompt TEXT NOT NULL,
 model TEXT NOT NULL, n INTEGER NOT NULL, refs TEXT NOT NULL DEFAULT '[]', demo INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'queued', created INTEGER NOT NULL, updated INTEGER NOT NULL, error TEXT,
 UNIQUE(owner,client_id)
);
CREATE TABLE IF NOT EXISTS images (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), position INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', account_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 url TEXT, object_key TEXT, local_path TEXT, mime TEXT, bytes INTEGER, error TEXT,
 started INTEGER, finished INTEGER, UNIQUE(task_id,position)
);
CREATE INDEX IF NOT EXISTS idx_images_queue ON images(status,task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner,created);
`)
// Existing queues keep their original settings when upgrading an installed service.
const taskColumns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(tasks)').all().map(column => column.name))
if (!taskColumns.has('size')) db.run("ALTER TABLE tasks ADD COLUMN size TEXT NOT NULL DEFAULT '1024x1024'")
if (!taskColumns.has('quality')) db.run("ALTER TABLE tasks ADD COLUMN quality TEXT NOT NULL DEFAULT 'auto'")
const imageColumns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(images)').all().map(column => column.name))
if (!imageColumns.has('queued_at')) {
  db.run('ALTER TABLE images ADD COLUMN queued_at INTEGER')
  db.run('UPDATE images SET queued_at=(SELECT created FROM tasks WHERE tasks.id=images.task_id)')
}
export type Account = { id: string; identity: string; name: string; email: string | null; source: 'web' | 'codex'; plan: string; status: string; quota: number | null; slots: number; inflight: number; success: number; fail: number; cooldown_until: number; last_error: string | null; last_refresh: number | null; last_used: number; created: number; secret: string }
export type Task = { id: string; owner: string; client_id: string | null; fingerprint: string; prompt: string; model: string; size: string; quality: string; n: number; refs: string; demo: number; status: string; created: number; updated: number; error: string | null }
export type ImageRow = { id: string; task_id: string; position: number; status: string; account_id: string | null; attempts: number; url: string | null; object_key: string | null; local_path: string | null; mime: string | null; bytes: number | null; error: string | null; queued_at: number | null; started: number | null; finished: number | null }
export type Settings = { globalConcurrency: number; taskConcurrency: number; queueLimit: number; jobTimeoutSeconds: number; refreshMinutes: number; storage: 'local' | 'oss'; publicBaseUrl: string; oss: { region: string; bucket: string; endpoint: string; accessKeyId: string; accessKeySecret: string; prefix: string; urlExpiry: number }; allowedImageHosts: string[] }
export const defaults: Settings = { globalConcurrency: 10, taskConcurrency: 2, queueLimit: 500, jobTimeoutSeconds: 600, refreshMinutes: 5, storage: 'local', publicBaseUrl: '', oss: { region: '', bucket: '', endpoint: '', accessKeyId: '', accessKeySecret: '', prefix: 'atelier', urlExpiry: 3600 }, allowedImageHosts: [] }
export function settings(): Settings {
  const row = db.query<{ secret: string }, []>('SELECT secret FROM settings WHERE id=1').get()
  return row ? unseal(row.secret) : structuredClone(defaults)
}
export function saveSettings(value: Settings) { db.run('INSERT INTO settings(id,secret) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret', [seal(value)]) }
export function publicSettings() {
  const s = settings()
  return { ...s, oss: { ...s.oss, accessKeyId: s.oss.accessKeyId ? `****${s.oss.accessKeyId.slice(-4)}` : '', accessKeySecret: '', hasCredentials: !!s.oss.accessKeyId && !!s.oss.accessKeySecret } }
}
export function publicAccount(account: Account) {
  const { secret, identity, ...rest } = account
  return { ...rest, hasRefreshToken: !!unseal(secret).refresh_token }
}
export const accounts = () => db.query<Account, []>('SELECT * FROM accounts ORDER BY created DESC').all()
export const getAccount = (value: string) => db.query<Account, [string]>('SELECT * FROM accounts WHERE id=?').get(value)
export const getTask = (value: string) => db.query<Task, [string]>('SELECT * FROM tasks WHERE id=?').get(value)
export const taskImages = (taskId: string) => db.query<ImageRow, [string]>('SELECT * FROM images WHERE task_id=? ORDER BY position').all(taskId)
export function publicTask(task: Task) {
  const rows = taskImages(task.id)
  return { ...task, refs: JSON.parse(task.refs), demo: !!task.demo, completed: rows.filter(i => i.status === 'success').length, failed: rows.filter(i => i.status === 'error').length, active: rows.filter(i => ['generating', 'uploading'].includes(i.status)).length, images: rows.map(({ local_path, ...row }) => row) }
}
export function recoverInterruptedTasks() {
  db.run('UPDATE accounts SET inflight=0')
  db.run("UPDATE images SET status='uploading',error='服务重启，等待重传' WHERE status IN ('generating','uploading') AND local_path IS NOT NULL")
  db.run("UPDATE images SET status='error',error='服务重启，生成结果未知。请确认上游后手动重试，避免重复生成。',finished=? WHERE status='generating' AND local_path IS NULL", [Date.now()])
  db.run("UPDATE tasks SET status='queued' WHERE status='running'")
  db.run('DELETE FROM sessions WHERE expires<?', [Date.now()])
}
