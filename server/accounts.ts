import { db, getAccount, hash, id, seal, unseal } from './store'

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const WEB_CLIENT_ID = 'app_2SKx67EdpoN0G6j64rFvigXD'
const tokenEndpoints = new Set(['https://auth.openai.com/oauth/token', 'https://auth.openai.com/api/accounts/oauth/token'])
export function normalizeAccount(raw: any, source: string, verified?: { sub: string; email?: string; accountId?: string }) {
  if (!raw || typeof raw !== 'object') throw new Error('账号凭证需要 JSON 对象或有效 Token')
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
export function saveAccount(item: ReturnType<typeof normalizeAccount>) {
  const existing = db.query<{ id: string; secret: string; inflight: number }, [string]>('SELECT id,secret,inflight FROM accounts WHERE identity=?').get(item.identity)
  if (existing) {
    if (existing.inflight) throw new Error('这个账号正在生图，请完成后再更新凭证')
    const credentials = unseal(existing.secret)
    for (const [key, value] of Object.entries(item.secret)) if (value !== '' && value !== undefined) credentials[key] = value
    db.run("UPDATE accounts SET secret=?,email=COALESCE(NULLIF(?,''),email),status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'pending' END,last_error=NULL,last_refresh=NULL WHERE id=?", [seal(credentials), item.email, existing.id])
    return { id: existing.id, added: false }
  }
  const accountId = id('acct')
  db.run('INSERT INTO accounts(id,identity,name,email,source,created,secret) VALUES(?,?,?,?,?,?,?)', [accountId, item.identity, item.name, item.email || null, item.source, Date.now(), seal(item.secret)])
  return { id: accountId, added: true }
}
