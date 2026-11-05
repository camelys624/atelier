import { db, getAccount, hash, id, seal, unseal, type Account } from './store'

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const WEB_CLIENT_ID = 'app_2SKx67EdpoN0G6j64rFvigXD'
const tokenEndpoints = new Set(['https://auth.openai.com/oauth/token', 'https://auth.openai.com/api/accounts/oauth/token'])
type NormalizedAccount = { identity: string; source: Account['source']; name: string; email: string; secret: Record<string, any>; slots?: number; updateName?: boolean }
export function normalizeAccount(raw: any, source: string, verified?: { sub: string; email?: string; accountId?: string }): NormalizedAccount {
  if (!raw || typeof raw !== 'object') throw new Error('账号凭证需要 JSON 对象或有效 Token')
  if (source === 'openai') {
    if (Object.keys(raw).some(key => !['api_key', 'name', 'slots'].includes(key))) throw new Error('API Key 配置包含未知字段')
    const key = typeof raw.api_key === 'string' ? raw.api_key.trim() : ''
    if (!/^sk-[A-Za-z0-9_-]+$/.test(key) || key.length < 20 || key.length > 512) throw new Error('请输入有效的 OpenAI API Key')
    if (raw.name !== undefined && (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 80)) throw new Error('API Key 名称需要 1～80 个字符')
    if (raw.slots !== undefined && (typeof raw.slots !== 'number' || !Number.isInteger(raw.slots) || raw.slots < 1 || raw.slots > 30)) throw new Error('API Key 并发上限需要是 1～30 的整数')
    return { identity: hash(`openai:${key}`), source: 'openai', name: raw.name?.trim() || `OpenAI API · ${key.slice(-4)}`, email: '', secret: { api_key: key }, slots: raw.slots, updateName: raw.name !== undefined }
  }
  const input = raw.tokens ? { ...raw, ...raw.tokens } : raw
  const access_token = String(input.access_token || input.accessToken || '').trim()
  if (access_token.length < 20) throw new Error('请输入有效的账号登录 Token')
  const resolvedSource = ['codex', 'web'].includes(input.source_type) ? input.source_type : input.type === 'codex' ? 'codex' : source
  let claims: any = {}
  try { claims = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64url').toString()) } catch {}
  const auth = claims['https://api.openai.com/auth'] || {}
  const stable = [verified?.accountId || auth.chatgpt_account_id, verified?.sub || claims.sub].filter(Boolean).join(':') || hash(access_token)
  const email = String(verified?.email || input.email || claims.email || '').trim()
  const endpoint = String(input.token_endpoint || 'https://auth.openai.com/oauth/token')
  if (!tokenEndpoints.has(endpoint)) throw new Error('不支持这个凭证刷新地址')
  const expires = Number(input.expires_at || claims.exp || 0)
  return { identity: hash(`${resolvedSource}:${stable}`), source: resolvedSource, name: String(input.name || email || '未命名账号').slice(0, 80), email, secret: {
    access_token, refresh_token: String(input.refresh_token || ''), id_token: String(input.id_token || ''), proxy: String(input.proxy || ''),
    client_id: String(input.client_id || (resolvedSource === 'codex' ? CODEX_CLIENT_ID : WEB_CLIENT_ID)),
    token_endpoint: endpoint, ...(Number.isFinite(expires) && expires > 0 ? { expires_at: expires } : {}),
  } }
}
export class AccountUpdateError extends Error {}
export function saveAccount(item: ReturnType<typeof normalizeAccount>, targetAccountId?: string) {
  const existing = targetAccountId ? getAccount(targetAccountId) : db.query<{ id: string; secret: string; inflight: number; identity: string }, [string]>('SELECT id,secret,inflight,identity FROM accounts WHERE identity=?').get(item.identity)
  if (targetAccountId && !existing) throw new AccountUpdateError('原账号已被删除，请返回账号池重新选择')
  if (targetAccountId && (item.source === 'openai' ? getAccount(targetAccountId)!.source !== 'openai' : existing!.identity !== item.identity)) throw new AccountUpdateError('授权账号与所选账号不一致，请使用原账号重新登录')
  if (existing) {
    if (existing.inflight) throw new AccountUpdateError('这个账号正在生图，请完成后再更新凭证')
    if (item.source === 'openai') {
      const duplicate = db.query<{ id: string }, [string]>('SELECT id FROM accounts WHERE identity=?').get(item.identity)
      if (duplicate && duplicate.id !== existing.id) throw new AccountUpdateError('这把 API Key 已存在于账号池，请直接使用对应记录')
      db.run("UPDATE accounts SET identity=?,secret=?,name=CASE WHEN ? THEN ? ELSE name END,slots=COALESCE(?,slots),plan='api',quota=NULL,status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'ready' END,last_error=NULL,last_refresh=?,cooldown_until=0 WHERE id=?", [item.identity, seal(item.secret), item.updateName ? 1 : 0, item.name, item.slots ?? null, Date.now(), existing.id])
      return { id: existing.id, added: false }
    }
    const credentials = unseal(existing.secret)
    for (const [key, value] of Object.entries(item.secret)) if (value !== '' && value !== undefined) credentials[key] = value
    db.run("UPDATE accounts SET secret=?,email=COALESCE(NULLIF(?,''),email),status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'pending' END,last_error=NULL,last_refresh=NULL,cooldown_until=0 WHERE id=?", [seal(credentials), item.email, existing.id])
    return { id: existing.id, added: false }
  }
  const accountId = id('acct')
  db.run('INSERT INTO accounts(id,identity,name,email,source,created,secret,status,plan,quota,slots,last_refresh) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [accountId, item.identity, item.name, item.email || null, item.source, Date.now(), seal(item.secret), item.source === 'openai' ? 'ready' : 'pending', item.source === 'openai' ? 'api' : 'unknown', null, item.slots ?? (item.source === 'openai' ? 5 : 1), item.source === 'openai' ? Date.now() : null])
  return { id: accountId, added: true }
}
