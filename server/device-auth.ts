import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose'
import { db, getAccount, id, seal, unseal } from './store'
import { CODEX_CLIENT_ID, normalizeAccount, saveAccount } from './accounts'
import { refreshAccount } from './adapter'

const ISSUER = 'https://auth.openai.com'
const VERIFICATION_URL = `${ISSUER}/codex/device`
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), { timeoutDuration: 10_000 })
const activeStates = ['pending', 'exchanging']
type AuthState = 'pending' | 'exchanging' | 'success' | 'failed' | 'expired' | 'cancelled'
type AuthRow = { id: string; owner: string; status: AuthState; created: number; expires: number; next_poll: number; interval: number; secret: string; error: string | null; account_id: string | null }
type AuthSecret = { deviceId: string; userCode: string; clientId: string }
export type DeviceAuthorization = { id: string; status: AuthState; verificationUrl: string; userCode: string; expires: number; pollInterval: number; error: string | null; accountId: string | null; accountStatus: string | null; accountName: string | null }
type VerifiedIdentity = { sub: string; email?: string; accountId?: string }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export class DeviceAuthError extends Error { constructor(public status: number, message: string) { super(message) } }
export async function verifyDeviceIdentity(value: string, clientId: string, resolver: JWTVerifyGetKey = jwks): Promise<VerifiedIdentity> {
  const { payload } = await jwtVerify(value, resolver, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'iat'], clockTolerance: 5 })
  const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
  if (!payload.sub) throw new Error('授权结果缺少账号身份')
  return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined, accountId: typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined }
}
export class DeviceAuthService {
  private fetcher: Fetcher
  private now: () => number
  private verify: typeof verifyDeviceIdentity
  private checkAccount: (accountId: string) => Promise<unknown>
  private starting = new Map<string, Promise<DeviceAuthorization>>()
  private active = new Map<string, AbortController>()
  private timer?: ReturnType<typeof setInterval>
  constructor(options: { fetcher?: Fetcher; now?: () => number; verify?: typeof verifyDeviceIdentity; checkAccount?: (id: string) => Promise<unknown> } = {}) {
    this.fetcher = options.fetcher || ((url, init) => fetch(url, init))
    this.now = options.now || Date.now
    this.verify = options.verify || verifyDeviceIdentity
    this.checkAccount = options.checkAccount || refreshAccount
  }
  private row(authId: string, owner?: string) {
    return owner === undefined ? db.query<AuthRow, [string]>('SELECT * FROM device_authorizations WHERE id=?').get(authId) : db.query<AuthRow, [string, string]>('SELECT * FROM device_authorizations WHERE id=? AND owner=?').get(authId, owner)
  }
  private finish(authId: string, status: AuthState, error: string | null = null) {
    db.run('UPDATE device_authorizations SET status=?,secret=?,error=? WHERE id=?', [status, seal({}), error, authId])
  }
  private expire() {
    const stale = db.query<AuthRow, [number]>("SELECT * FROM device_authorizations WHERE status IN ('pending','exchanging') AND expires<=?").all(this.now())
    for (const row of stale) { this.finish(row.id, 'expired', '设备码已过期，请重新生成'); this.active.get(row.id)?.abort() }
    db.run("DELETE FROM device_authorizations WHERE created<? AND status NOT IN ('pending','exchanging')", [this.now() - 86400_000])
  }
  get(authId: string, owner: string): DeviceAuthorization | null {
    this.expire()
    const row = this.row(authId, owner)
    if (!row) return null
    const secret = activeStates.includes(row.status) ? unseal<AuthSecret>(row.secret) : null
    const account = row.account_id ? getAccount(row.account_id) : null
    return { id: row.id, status: row.status, verificationUrl: VERIFICATION_URL, userCode: secret?.userCode || '', expires: row.expires, pollInterval: Math.max(3, row.interval), error: row.error, accountId: row.account_id, accountStatus: account?.status || null, accountName: account?.email || account?.name || null }
  }
  begin(owner: string) {
    const pending = this.starting.get(owner)
    if (pending) return pending
    const task = this.create(owner).finally(() => this.starting.delete(owner))
    this.starting.set(owner, task)
    return task
  }
  private async create(owner: string): Promise<DeviceAuthorization> {
    this.expire()
    const existing = db.query<AuthRow, [string]>("SELECT * FROM device_authorizations WHERE owner=? AND status IN ('pending','exchanging') ORDER BY created DESC LIMIT 1").get(owner)
    if (existing) return this.get(existing.id, owner)!
    const recent = db.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM device_authorizations WHERE owner=? AND created>?').get(owner, this.now() - 60_000)!.n
    if (recent >= 3) throw new DeviceAuthError(429, '设备码生成过于频繁，请一分钟后重试')
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM device_authorizations WHERE status IN ('pending','exchanging')").get()!.n
    if (count + this.starting.size >= 8) throw new DeviceAuthError(429, '待完成的授权过多，请稍后再试')
    const clientId = process.env.CODEX_OAUTH_CLIENT_ID?.trim() || CODEX_CLIENT_ID
    let response: Response
    try { response = await this.fetcher(`${ISSUER}/api/accounts/deviceauth/usercode`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: clientId }), signal: AbortSignal.timeout(20_000), redirect: 'error' }) }
    catch { throw new DeviceAuthError(502, '无法连接官方授权服务，请检查服务器的出站网络后重试') }
    if (!response.ok) {
      if (response.status === 429) throw new DeviceAuthError(429, '官方授权服务请求过多，请稍后重试')
      if ([403, 404].includes(response.status)) throw new DeviceAuthError(502, '官方设备码授权暂不可用，请检查网络与设备码登录权限；也可以手动导入账号')
      throw new DeviceAuthError(502, `设备码申请失败（HTTP ${response.status}），请稍后重试`)
    }
    let value: any
    try { value = await response.json() } catch { throw new DeviceAuthError(502, '授权服务未返回有效的设备码，请检查网络') }
    const deviceId = String(value.device_auth_id || ''), userCode = String(value.user_code || value.usercode || '')
    if (!deviceId || deviceId.length > 2048 || !/^[A-Za-z0-9-]{4,32}$/.test(userCode)) throw new DeviceAuthError(502, '官方授权服务返回了不完整的设备码')
    const interval = Math.min(60, Math.max(3, Number(value.interval) || 5))
    const ttl = Math.min(900, Math.max(30, Number(value.expires_in) || 900)) * 1000
    const now = this.now(), authId = id('auth')
    db.run('INSERT INTO device_authorizations(id,owner,status,created,expires,next_poll,interval,secret) VALUES(?,?,?,?,?,?,?,?)', [authId, owner, 'pending', now, now + ttl, now + interval * 1000, interval, seal({ deviceId, userCode, clientId })])
    return this.get(authId, owner)!
  }
  cancel(authId: string, owner: string) {
    const row = this.row(authId, owner)
    if (!row) return null
    if (activeStates.includes(row.status)) { this.finish(authId, 'cancelled'); this.active.get(authId)?.abort() }
    return this.get(authId, owner)
  }
  async tick() {
    this.expire()
    const rows = db.query<AuthRow, [number]>("SELECT * FROM device_authorizations WHERE status='pending' AND next_poll<=? ORDER BY created").all(this.now())
    await Promise.all(rows.map(row => this.poll(row)))
  }
  private alive(authId: string) { const row = this.row(authId); return !!row && activeStates.includes(row.status) && row.expires > this.now() }
  private async poll(row: AuthRow) {
    if (this.active.has(row.id)) return
    const abort = new AbortController()
    this.active.set(row.id, abort)
    db.run('UPDATE device_authorizations SET next_poll=? WHERE id=?', [this.now() + row.interval * 1000, row.id])
    const secret = unseal<AuthSecret>(row.secret)
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)])
    try {
      let response: Response
      try { response = await this.fetcher(`${ISSUER}/api/accounts/deviceauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ device_auth_id: secret.deviceId, user_code: secret.userCode }), signal, redirect: 'error' }) }
      catch { if (this.alive(row.id)) db.run('UPDATE device_authorizations SET next_poll=? WHERE id=?', [this.now() + 15_000, row.id]); return }
      if (!this.alive(row.id)) return
      let value: any = null
      try { value = await response.json() } catch {}
      const reason = typeof value?.error === 'string' ? value.error : value?.error?.code
      if (reason === 'access_denied' || reason === 'authorization_declined') { this.finish(row.id, 'failed', '已拒绝授权，可以重新开始'); return }
      if (['expired_token', 'device_code_expired'].includes(reason)) { this.finish(row.id, 'expired', '设备码已过期，请重新生成'); return }
      if ([403, 404].includes(response.status) || reason === 'authorization_pending') {
        if (!value && response.status === 403) this.finish(row.id, 'failed', '官方授权服务拒绝了连接，请检查服务器网络后重试')
        return
      }
      if (response.status === 429 || reason === 'slow_down') {
        const interval = Math.min(60, row.interval + 5)
        db.run('UPDATE device_authorizations SET interval=?,next_poll=? WHERE id=?', [interval, this.now() + interval * 1000, row.id]); return
      }
      if (response.status >= 500) { db.run('UPDATE device_authorizations SET next_poll=? WHERE id=?', [this.now() + 15_000, row.id]); return }
      if (!response.ok || !value?.authorization_code || !value?.code_verifier) { this.finish(row.id, 'failed', `授权确认失败（HTTP ${response.status}），请重新生成设备码`); return }
      const verifier = String(value.code_verifier)
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (value.code_challenge && new Bun.CryptoHasher('sha256').update(verifier).digest('base64url') !== value.code_challenge)) { this.finish(row.id, 'failed', '授权校验信息不匹配，请重新开始'); return }
      db.run("UPDATE device_authorizations SET status='exchanging' WHERE id=?", [row.id])
      // A code exchange is one-shot. Never retry an unknown outcome or expose its response to the browser.
      const tokenResponse = await this.fetcher(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: String(value.authorization_code), code_verifier: verifier, client_id: secret.clientId, redirect_uri: `${ISSUER}/deviceauth/callback` }).toString(), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]), redirect: 'error' })
      if (!this.alive(row.id)) return
      if (!tokenResponse.ok) { this.finish(row.id, 'failed', `凭证兑换失败（HTTP ${tokenResponse.status}），请重新开始授权`); return }
      const tokens = await tokenResponse.json() as Record<string, any>
      if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) { this.finish(row.id, 'failed', '授权未返回完整的登录与续期凭证，请重新开始'); return }
      const verified = await this.verify(tokens.id_token, secret.clientId)
      if (!this.alive(row.id)) return
      let accessExpiry = 0
      try { accessExpiry = Number(JSON.parse(Buffer.from(String(tokens.access_token).split('.')[1], 'base64url').toString()).exp) || 0 } catch {}
      const timestamp = Math.floor(this.now() / 1000)
      const expiresAt = Number(tokens.expires_in) > 0 ? timestamp + Number(tokens.expires_in) : accessExpiry > timestamp ? accessExpiry : timestamp + 3600
      const result = db.transaction(() => {
        if (!this.alive(row.id)) return null
        const saved = saveAccount(normalizeAccount({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token, client_id: secret.clientId, token_endpoint: TOKEN_ENDPOINT, expires_at: expiresAt, source_type: 'codex' }, 'codex', verified))
        db.run("UPDATE device_authorizations SET status='success',secret=?,account_id=?,error=NULL WHERE id=?", [seal({}), saved.id, row.id])
        return saved
      }).immediate()
      if (result) void this.checkAccount(result.id).catch(() => {})
    } catch (error) {
      if (this.alive(row.id)) this.finish(row.id, 'failed', error instanceof Error && error.message.includes('正在生图') ? '这个账号正在生图，请在任务完成后重新授权更新凭证' : '授权结果未通过验证或兑换结果未知，请重新开始授权')
    } finally { this.active.delete(row.id) }
  }
  start() {
    // A restart invalidates in-flight one-time-code exchanges. Tokens never remain in a public or partial record.
    db.run("UPDATE device_authorizations SET status='failed',secret=?,error='服务已重启，请重新开始授权' WHERE status IN ('pending','exchanging')", [seal({})])
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1000)
  }
  stop() { if (this.timer) clearInterval(this.timer); for (const abort of this.active.values()) abort.abort() }
}
export const deviceAuth = new DeviceAuthService()
