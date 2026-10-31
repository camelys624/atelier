import { resolve } from 'node:path'
import { dataDir, getAccount, seal, settings, unseal, db, type Account } from './store'

const children = new Set<ReturnType<typeof Bun.spawn>>()
class AdapterError extends Error { constructor(message: string, public kind: string) { super(message) } }
export function stopAdapters() { for (const child of children) child.kill('SIGTERM') }

export async function bridge(payload: Record<string, unknown>, timeoutSeconds = settings().jobTimeoutSeconds): Promise<any> {
  const child = Bun.spawn([process.env.PYTHON_BIN || 'python3', resolve('adapter/bridge.py')], {
    stdin: new Blob([JSON.stringify(payload)]), stdout: 'pipe', stderr: 'ignore',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), (timeoutSeconds + 15) * 1000)
  children.add(child)
  try {
    const [raw] = await Promise.all([new Response(child.stdout).text(), child.exited])
    let result
    try { result = JSON.parse(raw) } catch { throw new Error('上游适配器未返回结果，请检查 Python 依赖或任务超时设置') }
    if (!result.ok) {
      if (typeof payload.accountId === 'string') updateCredentials(payload.accountId, result.credentials)
      throw new AdapterError(result.error || '上游请求失败', result.error_kind || 'upstream')
    }
    return result
  } finally { clearTimeout(timer); children.delete(child) }
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
