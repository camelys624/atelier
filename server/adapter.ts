import { resolve } from 'node:path'
import { dataDir, getAccount, seal, settings, unseal, db, type Account } from './store'

const children = new Set<ReturnType<typeof Bun.spawn>>()
class AdapterError extends Error { constructor(message: string, public kind: string) { super(message) } }
const NO_RESULT = '上游适配器未返回结果，请检查 Python 依赖或任务超时设置'
const command = (...args: string[]) => [process.env.PYTHON_BIN || 'python3', resolve('adapter/bridge.py'), ...args]
const pythonEnv = () => ({ ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' })

// Each Python process costs ~50 MB before doing any work, and a request mostly waits on upstream.
// A few long-lived workers run requests on threads instead; ADAPTER_POOL=0 restores one process per request.
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type Worker = { child: Bun.Subprocess<'pipe', 'pipe', 'ignore'>; pending: Map<number, Pending>; draining: boolean }
const workers = new Set<Worker>()
let nextRequest = 0
const maxWorkers = () => Math.max(1, Number(process.env.ADAPTER_WORKERS) || 4)

export function stopAdapters() {
  for (const child of children) child.kill('SIGTERM')
  for (const worker of workers) { worker.draining = true; worker.child.kill('SIGTERM') }
  workers.clear()
}
export function adapterStats() {
  return { mode: process.env.ADAPTER_POOL === '0' ? 'process-per-request' : 'pool', workers: [...workers].map(w => ({ pid: w.child.pid, pending: w.pending.size, draining: w.draining })) }
}
function retire(worker: Worker) { if (worker.draining && !worker.pending.size) worker.child.kill('SIGTERM') }
function startWorker() {
  const child = Bun.spawn(command('--worker'), { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: pythonEnv() })
  const worker: Worker = { child, pending: new Map(), draining: false }
  workers.add(worker)
  void (async () => {
    const decoder = new TextDecoder(), reader = child.stdout.getReader()
    let buffer = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += decoder.decode(chunk.value, { stream: true })
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        const request = worker.pending.get(message.id)
        if (!request) continue
        worker.pending.delete(message.id); clearTimeout(request.timer); request.resolve(message)
      }
      retire(worker)
    }
  })().catch(() => {}).finally(() => {
    // stdout closes when the process exits: fail whatever it still owed.
    workers.delete(worker)
    for (const request of worker.pending.values()) { clearTimeout(request.timer); request.reject(new Error('上游适配器进程已退出，请检查 Python 依赖后重试')) }
    worker.pending.clear()
  })
  return worker
}
function pickWorker() {
  let best: Worker | undefined, live = 0
  for (const worker of workers) {
    if (worker.draining) continue
    live++
    if (!best || worker.pending.size < best.pending.size) best = worker
  }
  return best && (!best.pending.size || live >= maxWorkers()) ? best : startWorker()
}
function pooled(payload: Record<string, unknown>, timeoutSeconds: number): Promise<any> {
  const worker = pickWorker(), id = ++nextRequest
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(id)
      // A Python thread cannot be cancelled: stop routing work to this process and recycle it once its other requests finish.
      worker.draining = true; retire(worker)
      reject(new Error(NO_RESULT))
    }, (timeoutSeconds + 15) * 1000)
    worker.pending.set(id, { resolve, reject, timer })
    try { worker.child.stdin.write(JSON.stringify({ id, payload }) + '\n'); void worker.child.stdin.flush() }
    catch { worker.pending.delete(id); clearTimeout(timer); reject(new Error('上游适配器进程已退出，请检查 Python 依赖后重试')) }
  })
}
async function spawned(payload: Record<string, unknown>, timeoutSeconds: number) {
  const child = Bun.spawn(command(), { stdin: new Blob([JSON.stringify(payload)]), stdout: 'pipe', stderr: 'ignore', env: pythonEnv() })
  const timer = setTimeout(() => child.kill('SIGKILL'), (timeoutSeconds + 15) * 1000)
  children.add(child)
  try {
    const [raw] = await Promise.all([new Response(child.stdout).text(), child.exited])
    try { return JSON.parse(raw) } catch { throw new Error(NO_RESULT) }
  } finally { clearTimeout(timer); children.delete(child) }
}

export async function bridge(payload: Record<string, unknown>, timeoutSeconds = settings().jobTimeoutSeconds): Promise<any> {
  const result = process.env.ADAPTER_POOL === '0' ? await spawned(payload, timeoutSeconds) : await pooled(payload, timeoutSeconds)
  if (!result.ok) {
    if (typeof payload.accountId === 'string') updateCredentials(payload.accountId, result.credentials)
    throw new AdapterError(result.error || '上游请求失败', result.error_kind || 'upstream')
  }
  return result
}
export function credentials(account: Account) {
  return { ...unseal(account.secret), source_type: account.source, type: account.plan, email: account.email }
}
export function updateCredentials(accountId: string, values: any) {
  const current = getAccount(accountId)
  if (!current || !values) return
  db.run('UPDATE accounts SET secret=? WHERE id=?', [seal({ ...unseal<Record<string, unknown>>(current.secret), ...values }), accountId])
}
const refreshing = new Set<string>()
export async function refreshAccount(accountId: string) {
  if (refreshing.has(accountId)) return
  const account = getAccount(accountId)
  if (!account || account.inflight > 0 || account.status === 'disabled') return
  refreshing.add(accountId)
  db.run("UPDATE accounts SET status='refreshing' WHERE id=? AND status!='disabled'", [accountId])
  try {
    const result = await bridge({ action: 'refresh', accountId, account: credentials(account) }, 90)
    updateCredentials(accountId, result.credentials)
    const info = result.info
    // The reference adapter reports web image quota. Do not pretend it is Codex's quota.
    const quota = account.source === 'codex' ? null : Number(info.quota || 0)
    db.run("UPDATE accounts SET email=?,plan=?,quota=?,status=CASE WHEN status='disabled' THEN 'disabled' ELSE ? END,last_refresh=?,last_error=NULL,cooldown_until=0 WHERE id=?", [info.email || account.email, info.type || 'unknown', quota, quota === 0 ? 'limited' : 'ready', Date.now(), accountId])
  } catch (error) {
    const network = error instanceof AdapterError && error.kind === 'network'
    const message = network ? `账号验证时网络连接失败，约30秒后自动重试：${safeError(error)}` : safeError(error)
    db.run("UPDATE accounts SET status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'error' END,last_error=?,last_refresh=?,cooldown_until=? WHERE id=?", [message, Date.now(), network ? Date.now() + 30_000 : 0, accountId])
    console.warn(JSON.stringify({ event: 'account_verification_failed', time: new Date().toISOString(), accountId, kind: network ? 'network' : 'upstream', message }))
    if (network) throw new Error(message)
    throw error
  } finally { refreshing.delete(accountId) }
}
export function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_.-]{30,}/g, '[redacted]').replace(/https?:\/\/[^\s]+/g, '[upstream]').slice(0, 350)
}
export async function generateImage(account: Account, request: { prompt: string; model: string; size: string; quality: string; images: string[]; imageId: string }) {
  const output = resolve(dataDir, 'spool', `${request.imageId}.png`)
  const result = await bridge({ action: 'generate', accountId: account.id, account: credentials(account), prompt: request.prompt, model: request.model, size: request.size, quality: request.quality, images: request.images, output, timeout: settings().jobTimeoutSeconds })
  updateCredentials(account.id, result.credentials)
  return { path: output, mime: result.mime || 'image/png', bytes: result.bytes }
}
