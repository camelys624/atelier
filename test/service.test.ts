import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import OSS from 'ali-oss'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'

const temporary = mkdtempSync(join(tmpdir(), 'atelier-test-'))
process.env.DATA_DIR = temporary
process.env.ADMIN_KEY = 'sk-admin-test-only-01234567890123456789'
process.env.MASTER_KEY = '11'.repeat(32)
const store = await import('../server/store')
const { handleApi } = await import('../server/api')
const scheduler = await import('../server/scheduler')
const { validateImageUrl } = await import('../server/network')
const { DeviceAuthService, verifyDeviceIdentity } = await import('../server/device-auth')
const { CODEX_CLIENT_ID, WEB_CLIENT_ID } = await import('../server/accounts')
const { MAX_UPLOAD_BYTES, referencePath, uploadedReference } = await import('../server/image-input')
const { imageBase64 } = await import('../server/storage')
const { refreshAccount } = await import('../server/adapter')
const { needsAccountRefresh } = await import('../server/account-policy')
const { db, defaults, seal, unseal, getTask, taskImages, saveSettings } = store
const admin = { Authorization: `Bearer ${process.env.ADMIN_KEY}` }
function request(path: string, body?: any, headers: Record<string, string> = admin, method?: string) {
  return handleApi(new Request(`http://127.0.0.1:3080${path}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }))
}
function account(accountId: string, quota: number | null = 10, slots = 1) {
  db.run("INSERT INTO accounts(id,identity,name,source,plan,status,quota,slots,created,secret) VALUES(?,?,?,'web','Plus','ready',?,?,?,?)", [accountId, accountId, accountId, quota, slots, Date.now(), seal({ access_token: 'test-token-never-sent-to-upstream' })])
}
function task(owner = 'admin', n = 7, clientId?: string) { return scheduler.submitTask({ owner, prompt: 'test prompt', model: 'gpt-image-2', n, refs: [], clientId }) }
async function waitFor(check: () => boolean, timeout = 10_000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await Bun.sleep(25) } }
beforeEach(() => { db.exec('DELETE FROM images; DELETE FROM tasks; DELETE FROM accounts; DELETE FROM api_keys; DELETE FROM sessions; DELETE FROM settings; DELETE FROM device_authorizations;'); saveSettings(structuredClone(defaults)) })
afterAll(() => { db.close(); rmSync(temporary, { recursive: true, force: true }) })

describe('image edit SDK compatibility', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  function form(fields: Record<string, string> = {}, files: Blob[] = [new Blob([png], { type: 'image/png' })], key = 'image[]') {
    const body = new FormData()
    for (const [name, value] of Object.entries({ model: 'gpt-image-2.5-sunburst', prompt: '把图1人物放进图2场景，沿用图3的色彩风格，保持光线一致', size: '1536x1024', quality: 'high', ...fields })) body.set(name, value)
    files.forEach((file, i) => body.append(key, file, `reference-${i}.png`))
    return body
  }
  const edit = (body: FormData, headers: Record<string, string> = admin) => handleApi(new Request('http://127.0.0.1:3080/v1/images/edits', { method: 'POST', headers, body }))
  test('accepts real multipart uploads, preserves order/settings, returns PNG base64 and reuses identical retries', async () => {
    // A separate executable stands in for the upstream protocol, with no network or real credentials.
    const previous = process.env.PYTHON_BIN, fake = join(temporary, 'fake-image-adapter'), capture = join(temporary, 'adapter-request.json')
    writeFileSync(fake, `#!${process.execPath}\nconst p=await new Response(Bun.stdin).json(); await Bun.write(${JSON.stringify(capture)},JSON.stringify(p)); await Bun.write(p.output,Buffer.from(${JSON.stringify(png.toString('base64'))},'base64')); console.log(JSON.stringify({ok:true,mime:'image/png',bytes:${png.length}}));\n`)
    chmodSync(fake, 0o700); process.env.PYTHON_BIN = fake
    account('codex-sdk'); db.run("UPDATE accounts SET source='codex',plan='prolite' WHERE id='codex-sdk'")
    const refs = [new Blob([png]), new Blob([png, 'second']), new Blob([png, 'third'])]
    try {
      const first = await edit(form({}, refs), { ...admin, 'Idempotency-Key': 'sdk-edit' })
      const value = await first.json()
      expect(first.status).toBe(200)
      expect(Buffer.from(value.data[0].b64_json, 'base64')).toEqual(png)
      expect(value.data[0].url).toBeUndefined()
      const saved = getTask(value.task_id)!
      expect(saved.model).toBe('gpt-image-2.5-sunburst'); expect(saved.size).toBe('1536x1024'); expect(saved.quality).toBe('high')
      const payload = await Bun.file(capture).json()
      expect(payload.model).toBe(saved.model); expect(payload.size).toBe(saved.size); expect(payload.quality).toBe(saved.quality)
      expect(payload.images).toEqual(await Promise.all(refs.map(async file => `data:image/png;base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`)))
      const references = JSON.parse(saved.refs)
      expect(references).toHaveLength(3)
      expect(await uploadedReference(references[0])).toBe(payload.images[0])
      expect(await Bun.file(referencePath(references[0])).exists()).toBe(true)
      const repeated = await edit(form({}, refs), { ...admin, 'Idempotency-Key': 'sdk-edit' })
      expect(repeated.status).toBe(200); expect((await repeated.json()).task_id).toBe(saved.id)
      expect((await edit(form({ quality: 'medium' }, refs), { ...admin, 'Idempotency-Key': 'sdk-edit' })).status).toBe(400)
      expect((await edit(form({ size: '1024x1024' }, refs), { ...admin, 'Idempotency-Key': 'sdk-edit' })).status).toBe(400)
      const url = await edit(form({ response_format: 'url' }, refs), { ...admin, 'Idempotency-Key': 'sdk-edit' })
      const urlValue = await url.json()
      expect(url.status).toBe(200); expect(urlValue.data[0].url).toContain('/media/'); expect(urlValue.data[0].b64_json).toBeUndefined()
      expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tasks').get()!.n).toBe(1)
    } finally { if (previous === undefined) delete process.env.PYTHON_BIN; else process.env.PYTHON_BIN = previous }
  })
  test('accepts singular image and parsed form booleans; stores references for queued retries', async () => {
    const response = await edit(form({ async: 'true', demo: 'true', stream: 'false' }, undefined, 'image'))
    expect(response.status).toBe(202)
    const task = await response.json()
    expect(task.size).toBe('1536x1024'); expect(task.quality).toBe('high')
    await waitFor(() => getTask(task.id)!.status === 'success')
    const refs = JSON.parse(getTask(task.id)!.refs)
    expect(Buffer.from((await uploadedReference(refs[0])).split(',')[1], 'base64')).toEqual(png)
  })
  test('accepts JSON image URL under the new image field and the existing OSS fields', async () => {
    saveSettings({ ...defaults, allowedImageHosts: ['8.8.8.8'] })
    for (const imageField of [{ image: ['https://8.8.8.8/person.png'] }, { images: [{ image_url: 'https://8.8.8.8/person.png' }] }, { image_urls: ['https://8.8.8.8/person.png'] }]) {
      const response = await request('/v1/images/edits', { model: 'gpt-image-2.5-sunburst', prompt: 'test', ...imageField, size: '1536x1024', quality: 'high', async: true, demo: true })
      expect(response.status).toBe(202)
      const value = await response.json()
      expect(value.refs).toEqual(['https://8.8.8.8/person.png'])
      await waitFor(() => getTask(value.id)!.status === 'success')
    }
  })
  test('rejects empty/malformed/oversized uploads, invalid settings and unsupported fields before queuing', async () => {
    expect((await edit(form({}, []))).status).toBe(400)
    expect((await edit(form({}, [new Blob([])]))).status).toBe(400)
    expect((await edit(form({}, [new Blob(['not-an-image'], { type: 'image/png' })]))).status).toBe(400)
    expect((await edit(form({}, Array.from({ length: 8 }, () => new Blob([png]))))).status).toBe(400)
    expect((await edit(form({}, [new Blob([new Uint8Array(10 * 1024 * 1024 + 1)])]))).status).toBe(413)
    expect((await edit(form(), { ...admin, 'Content-Length': String(MAX_UPLOAD_BYTES + 1) })).status).toBe(413)
    const invalidFields: Record<string, string>[] = [{ size: 'bogus' }, { quality: 'ultra' }, { stream: 'true' }, { mask: 'unsupported' }, { output_format: 'jpeg' }]
    for (const fields of invalidFields) expect((await edit(form(fields))).status).toBe(400)
    expect((await edit(form(), {})).status).toBe(401)
    const text = await handleApi(new Request('http://localhost/v1/images/edits', { method: 'POST', headers: { ...admin, 'Content-Type': 'multipart/form-data; boundary=missing' }, body: 'broken' }))
    expect(text.status).toBe(400)
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tasks').get()!.n).toBe(0)
    await expect(uploadedReference('upload:../../secret')).rejects.toThrow()
  })
  test('returns a useful account error instead of rejecting the supported model', async () => {
    const response = await edit(form())
    expect(response.status).toBe(409)
    expect((await response.json()).error.message).toContain('账号')
    expect((await request('/v1/models')).status).toBe(200)
    expect((await (await request('/v1/models')).json()).data.some((model: any) => model.id === 'gpt-image-2.5-sunburst')).toBe(true)
  })
  test('reads Base64 from OSS after the local generated file has been cleaned up', async () => {
    saveSettings({ ...defaults, storage: 'oss', oss: { ...defaults.oss, region: 'oss-cn-hangzhou', bucket: 'disposable-test-bucket', accessKeyId: 'test-only-access-key', accessKeySecret: 'test-only-secret' } })
    const get = spyOn(OSS.prototype, 'get').mockResolvedValue({ content: png } as any)
    try {
      expect(await imageBase64({ object_key: 'atelier/task/image.png', local_path: join(temporary, 'already-deleted.png') })).toBe(png.toString('base64'))
      expect(get).toHaveBeenCalledWith('atelier/task/image.png')
    } finally { get.mockRestore() }
  })
})

describe('account validation network failures', () => {
  test('preserves rotated tokens, schedules a short network retry, then recovers without reimporting', async () => {
    account('transient-network')
    const previous = process.env.PYTHON_BIN, fake = join(temporary, 'fake-validation-adapter')
    const configure = (result: unknown) => {
      writeFileSync(fake, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(result))});\n`)
      chmodSync(fake, 0o700)
    }
    process.env.PYTHON_BIN = fake
    try {
      configure({ ok: false, error_kind: 'network', error: 'curl: (35) TLS connect error', credentials: { access_token: 'rotated-after-refresh', refresh_token: 'new-refresh-token' } })
      await expect(refreshAccount('transient-network')).rejects.toThrow('30秒后自动重试')
      const failed = store.getAccount('transient-network')!
      expect(failed.status).toBe('error')
      expect(unseal(failed.secret).refresh_token).toBe('new-refresh-token')
      expect(needsAccountRefresh(failed, failed.cooldown_until - 1, 5)).toBe(false)
      expect(needsAccountRefresh(failed, failed.cooldown_until, 5)).toBe(true)
      configure({ ok: true, info: { type: 'Plus', quota: 10 } })
      await refreshAccount('transient-network')
      const recovered = store.getAccount('transient-network')!
      expect(recovered.status).toBe('ready'); expect(recovered.last_error).toBeNull(); expect(recovered.cooldown_until).toBe(0)
    } finally { if (previous === undefined) delete process.env.PYTHON_BIN; else process.env.PYTHON_BIN = previous }
  })
  test('does not retry an invalid credential or a disabled/busy account on the short network schedule', () => {
    const now = Date.now(), base = { status: 'error', inflight: 0, last_refresh: now, cooldown_until: 0 }
    expect(needsAccountRefresh(base, now + 30000, 5)).toBe(false)
    expect(needsAccountRefresh({ ...base, status: 'disabled', cooldown_until: now - 1 }, now, 5)).toBe(false)
    expect(needsAccountRefresh({ ...base, inflight: 1, cooldown_until: now - 1 }, now, 5)).toBe(false)
  })
})

describe('authentication and secret handling', () => {
  test('rejects missing keys and cross-origin mutations', async () => {
    expect((await request('/api/bootstrap', undefined, {})).status).toBe(401)
    const login = await request('/api/auth/login', { key: process.env.ADMIN_KEY }, { Origin: 'https://untrusted.example' })
    expect(login.status).toBe(403)
    expect((await request('/api/auth/login', { key: 'wrong' }, {})).status).toBe(401)
  })
  test('uses an HttpOnly session cookie and does not return credentials', async () => {
    const login = await request('/api/auth/login', { key: process.env.ADMIN_KEY }, {})
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toContain('HttpOnly')
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    expect((await request('/api/bootstrap', undefined, { Cookie: cookie })).status).toBe(200)
    account('a')
    const text = await (await request('/api/bootstrap')).text()
    expect(text).not.toContain('test-token-never-sent-to-upstream')
    expect(text).not.toContain('MASTER_KEY')
  })
  test('encrypts and authenticates stored credentials', () => {
    const encrypted = seal({ token: 'sensitive-token' })
    expect(encrypted).not.toContain('sensitive-token')
    expect(unseal(encrypted)).toEqual({ token: 'sensitive-token' })
    const modified = Buffer.from(encrypted, 'base64'); modified[31] ^= 1
    expect(() => unseal(modified.toString('base64'))).toThrow()
  })
  test('business keys cannot manage accounts or query another owner task', async () => {
    const created = await (await request('/api/keys', { name: 'Business A' })).json()
    const headers = { Authorization: `Bearer ${created.key}` }
    expect((await request('/api/bootstrap', undefined, headers)).status).toBe(403)
    expect((await request('/v1/models', undefined, headers)).status).toBe(200)
    const other = task('another-business', 1)
    expect((await request(`/v1/image-tasks/${other.id}`, undefined, headers)).status).toBe(404)
    const key = db.query<{ id: string }, []>('SELECT id FROM api_keys LIMIT 1').get()!
    await request(`/api/keys/${key.id}`, undefined, admin, 'DELETE')
    expect((await request('/v1/models', undefined, headers)).status).toBe(401)
  })
  test('deduplicates tokens belonging to the same identity and source', async () => {
    const make = (suffix: string) => `header.${Buffer.from(JSON.stringify({ sub: 'same-user', email: 'test@example.com' })).toString('base64url')}.${suffix}`
    await request('/api/accounts', { items: [{ access_token: make('first') }, { access_token: make('rotated') }], source: 'web' })
    expect(store.accounts().length).toBe(1)
    expect(store.accounts()[0].status).toBe('pending')
    expect(unseal(store.accounts()[0].secret).access_token).toBe(make('rotated'))
  })
})

describe('device authorization', () => {
  const verifier = 'v'.repeat(43)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const grant = { authorization_code: 'single-use-code-not-for-browser', code_verifier: verifier, code_challenge: challenge }
  const tokens = { access_token: 'access-token-kept-on-the-server-0123456789', refresh_token: 'refresh-token-kept-on-the-server', id_token: 'id-token-kept-on-the-server', expires_in: 7200 }
  function fixture(responses: Array<Response | (() => Promise<Response>)> = []) {
    let now = Date.now(), checked = 0
    const calls: { url: string; init: RequestInit }[] = []
    const service = new DeviceAuthService({
      now: () => now,
      fetcher: async (url, init) => {
        calls.push({ url, init })
        if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'backend-only-device-id', usercode: 'ABCD-1234', interval: '5' })
        const response = responses.shift()
        if (!response) throw new Error('Unexpected upstream request')
        return typeof response === 'function' ? response() : response
      },
      verify: async (_token, clientId) => { expect(clientId).toBe(CODEX_CLIENT_ID); return { sub: 'verified-account-id', email: 'oauth@example.com', accountId: 'workspace-a' } },
      checkAccount: async () => { checked++ },
    })
    return { service, calls, advance: (ms: number) => { now += ms }, checked: () => checked }
  }
  test('exposes only the official page and user code; binds sessions to their initiator', async () => {
    const f = fixture(), value = await f.service.begin('browser-a')
    expect(value.verificationUrl).toBe('https://auth.openai.com/codex/device')
    expect(value.userCode).toBe('ABCD-1234')
    expect(f.service.get(value.id, 'browser-b')).toBeNull()
    expect(JSON.stringify(value)).not.toContain('backend-only-device-id')
    const stored = db.query<{ secret: string }, [string]>('SELECT secret FROM device_authorizations WHERE id=?').get(value.id)!
    expect(stored.secret).not.toContain('backend-only-device-id')
    expect(unseal(stored.secret).deviceId).toBe('backend-only-device-id')
    expect((await f.service.begin('browser-a')).id).toBe(value.id)
    expect(f.calls).toHaveLength(1)
    const fromApi = await request(`/api/accounts/authorize/${value.id}`)
    expect(fromApi.status).toBe(404)
    expect((await request('/api/accounts/authorize', {}, {})).status).toBe(401)
  })
  test('obeys upstream polling intervals and backoff', async () => {
    const f = fixture([Response.json({}, { status: 404 }), Response.json({ error: 'slow_down' }, { status: 429 })])
    const value = await f.service.begin('browser-a')
    await f.service.tick(); expect(f.calls).toHaveLength(1)
    f.advance(5000); await f.service.tick(); expect(f.calls).toHaveLength(2)
    await f.service.tick(); expect(f.calls).toHaveLength(2)
    f.advance(5000); await f.service.tick()
    expect(f.service.get(value.id, 'browser-a')!.pollInterval).toBe(10)
    f.advance(9000); await f.service.tick(); expect(f.calls).toHaveLength(3)
  })
  test('exchanges once, verifies identity, encrypts credentials and starts account validation', async () => {
    const f = fixture([Response.json(grant), Response.json(tokens)])
    const started = await f.service.begin('browser-a')
    f.advance(5000); await f.service.tick()
    const result = f.service.get(started.id, 'browser-a')!
    expect(result.status).toBe('success')
    expect(result.userCode).toBe('')
    expect(result.accountName).toBe('oauth@example.com')
    const saved = store.getAccount(result.accountId!)!
    expect(saved.source).toBe('codex')
    const credentials = unseal(saved.secret)
    expect(credentials.access_token).toBe(tokens.access_token)
    expect(credentials.client_id).toBe(CODEX_CLIENT_ID)
    expect(credentials.token_endpoint).toBe('https://auth.openai.com/oauth/token')
    expect(credentials.expires_at).toBeGreaterThan(Date.now() / 1000 + 7000)
    expect(saved.secret).not.toContain(tokens.refresh_token)
    expect(JSON.stringify(result)).not.toContain(tokens.access_token)
    expect(f.checked()).toBe(1)
    const exchange = new URLSearchParams(String(f.calls[2].init.body))
    expect(exchange.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback')
    expect(exchange.get('code_verifier')).toBe(verifier)
    expect(exchange.get('client_id')).toBe(CODEX_CLIENT_ID)
    await f.service.tick(); expect(f.calls).toHaveLength(3)
    expect(unseal(db.query<{ secret: string }, [string]>('SELECT secret FROM device_authorizations WHERE id=?').get(started.id)!.secret)).toEqual({})
  })
  test('rejects a mismatched PKCE verifier without exchanging a code', async () => {
    const f = fixture([Response.json({ ...grant, code_challenge: 'incorrect' })])
    const value = await f.service.begin('browser-a'); f.advance(5000); await f.service.tick()
    expect(f.service.get(value.id, 'browser-a')!.status).toBe('failed')
    expect(f.calls).toHaveLength(2)
    expect(store.accounts()).toHaveLength(0)
  })
  test('does not import late authorization after cancellation', async () => {
    let resolve: (response: Response) => void = () => {}
    const f = fixture([() => new Promise<Response>(done => { resolve = done })])
    const value = await f.service.begin('browser-a'); f.advance(5000)
    const pending = f.service.tick()
    f.service.cancel(value.id, 'browser-a')
    resolve(Response.json(grant)); await pending
    expect(f.service.get(value.id, 'browser-a')!.status).toBe('cancelled')
    expect(f.service.get(value.id, 'browser-a')!.userCode).toBe('')
    expect(store.accounts()).toHaveLength(0)
    expect(f.calls).toHaveLength(2)
  })
  test('expires codes and invalidates in-flight sessions after restart', async () => {
    const f = fixture(), value = await f.service.begin('browser-a')
    f.advance(901_000)
    expect(f.service.get(value.id, 'browser-a')!.status).toBe('expired')
    expect(f.service.get(value.id, 'browser-a')!.userCode).toBe('')
    const restarted = await f.service.begin('browser-a')
    f.service.start(); f.service.stop()
    expect(f.service.get(restarted.id, 'browser-a')!.status).toBe('failed')
    expect(f.service.get(restarted.id, 'browser-a')!.error).toContain('重启')
  })
  test('does not retry one-time token exchanges with uncertain outcomes', async () => {
    const f = fixture([Response.json(grant), async () => { throw new Error('network disconnected after POST') }])
    const value = await f.service.begin('browser-a'); f.advance(5000); await f.service.tick()
    expect(f.service.get(value.id, 'browser-a')!.status).toBe('failed')
    f.advance(30_000); await f.service.tick()
    expect(f.calls).toHaveLength(3)
    expect(store.accounts()).toHaveLength(0)
  })
  test('bounds code creation and handles provider rejection without exposing response bodies', async () => {
    const f = fixture()
    for (let i = 0; i < 3; i++) { const result = await f.service.begin('browser-a'); f.service.cancel(result.id, 'browser-a') }
    await expect(f.service.begin('browser-a')).rejects.toThrow('频繁')
    const rejected = new DeviceAuthService({ fetcher: async () => Response.json({ secret: 'never-display-this-provider-payload' }, { status: 403 }) })
    await expect(rejected.begin('browser-b')).rejects.toThrow('暂不可用')
  })
  test('validates JWT signature, issuer, audience and expiry before accepting identity', async () => {
    const pair = await generateKeyPair('RS256'), jwk = await exportJWK(pair.publicKey)
    const resolver = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test' }] })
    const sign = (audience = CODEX_CLIENT_ID, issuer = 'https://auth.openai.com', expires = '1h') => new SignJWT({ email: 'verified@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience(audience).setSubject('verified-user').setIssuedAt().setExpirationTime(expires).sign(pair.privateKey)
    expect((await verifyDeviceIdentity(await sign(), CODEX_CLIENT_ID, resolver)).sub).toBe('verified-user')
    await expect(verifyDeviceIdentity(await sign('wrong-client'), CODEX_CLIENT_ID, resolver)).rejects.toThrow()
    await expect(verifyDeviceIdentity(await sign(CODEX_CLIENT_ID, 'https://untrusted.example'), CODEX_CLIENT_ID, resolver)).rejects.toThrow()
    await expect(verifyDeviceIdentity(await sign(CODEX_CLIENT_ID, 'https://auth.openai.com', '-1h'), CODEX_CLIENT_ID, resolver)).rejects.toThrow()
    const wrong = await generateKeyPair('RS256')
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://auth.openai.com').setAudience(CODEX_CLIENT_ID).setSubject('forged').setIssuedAt().setExpirationTime('1h').sign(wrong.privateKey)
    await expect(verifyDeviceIdentity(forged, CODEX_CLIENT_ID, resolver)).rejects.toThrow()
  })
  test('preserves matching refresh client metadata on manually imported accounts', async () => {
    await request('/api/accounts', { source: 'codex', items: { access_token: 'opaque-codex-token-01234567890123456789', client_id: 'custom-client', refresh_token: 'refresh-value' } })
    expect(unseal(store.accounts()[0].secret).client_id).toBe('custom-client')
    await request('/api/accounts', { source: 'web', items: { access_token: 'opaque-web-token-01234567890123456789' } })
    const web = store.accounts().find(a => a.source === 'web')!
    expect(unseal(web.secret).client_id).toBe(WEB_CLIENT_ID)
  })
})

describe('durable queue and resource reservations', () => {
  test('creates seven independent image jobs and handles idempotency conflicts', () => {
    const first = task('admin', 7, 'order-001'), duplicate = task('admin', 7, 'order-001')
    expect(first.id).toBe(duplicate.id)
    expect(taskImages(first.id)).toHaveLength(7)
    expect(() => scheduler.submitTask({ owner: 'admin', prompt: 'different', n: 7, model: 'gpt-image-2', refs: [], clientId: 'order-001' })).toThrow('幂等')
  })
  test('enforces global, per-task and per-account concurrency', () => {
    saveSettings({ ...defaults, globalConcurrency: 3, taskConcurrency: 2 })
    account('a', 10, 1); account('b', 10, 1); account('c', 10, 1); account('d', 10, 1)
    const first = task(), second = task()
    expect(scheduler.claimImage()!.task.id).toBe(first.id)
    expect(scheduler.claimImage()!.task.id).toBe(first.id)
    expect(scheduler.claimImage()!.task.id).toBe(second.id)
    expect(scheduler.claimImage()).toBeNull()
    expect(store.accounts().reduce((sum, a) => sum + a.inflight, 0)).toBe(3)
  })
  test('reserves quota so a one-image balance cannot accept three images', () => {
    saveSettings({ ...defaults, globalConcurrency: 10, taskConcurrency: 7 })
    account('a', 1, 3); task()
    expect(scheduler.claimImage()).not.toBeNull()
    expect(scheduler.claimImage()).toBeNull()
  })
  test('rejects queue overflow before inserting a partial task', () => {
    saveSettings({ ...defaults, queueLimit: 10 })
    task()
    expect(() => task()).toThrow('队列已满')
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tasks').get()!.n).toBe(1)
  })
  test('does not blindly regenerate images interrupted by a restart', () => {
    account('a'); const submitted = task('admin', 2)
    scheduler.claimImage()
    store.recoverInterruptedTasks()
    const images = taskImages(submitted.id)
    expect(images[0].status).toBe('error')
    expect(images[0].error).toContain('避免重复生成')
    expect(images[1].status).toBe('queued')
    expect(store.getAccount('a')!.inflight).toBe(0)
  })
  test('retries an existing generated file by uploading only', async () => {
    const submitted = task('admin', 1), image = taskImages(submitted.id)[0], path = join(temporary, 'existing-result.png')
    writeFileSync(path, 'previously-generated-image')
    db.run("UPDATE images SET status='error',local_path=?,mime='image/png',attempts=1 WHERE id=?", [path, image.id])
    scheduler.retryTask(submitted.id)
    await waitFor(() => getTask(submitted.id)!.status === 'success')
    const result = taskImages(submitted.id)[0]
    expect(result.attempts).toBe(1)
    expect(result.url).toContain('/media/')
    expect(await Bun.file(path).text()).toBe('previously-generated-image')
  })
  test('runs a clearly labeled seven-image demo end to end', async () => {
    const response = await request('/api/tasks', { prompt: 'Test local demonstration', n: 7, demo: true })
    expect(response.status).toBe(202)
    const submitted = await response.json()
    expect(submitted.demo).toBe(true)
    await waitFor(() => getTask(submitted.id)!.status === 'success')
    const images = taskImages(submitted.id)
    expect(images).toHaveLength(7)
    expect(images.every(i => i.status === 'success' && i.url?.includes('/media/'))).toBe(true)
    expect(await Bun.file(images[0].local_path!).text()).toContain('SYNTHETIC PREVIEW')
  })
  test('rejects invalid response formats and live requests with no usable accounts', async () => {
    expect((await request('/v1/image-tasks', { prompt: 'x', n: 7 })).status).toBe(409)
    expect((await request('/v1/images/generations', { prompt: 'x', response_format: 'invalid' })).status).toBe(400)
    expect((await request('/v1/image-tasks', { prompt: 'x', n: 8 })).status).toBe(400)
  })
  test('returns the original idempotent task even when no account remains available', async () => {
    const existing = task('admin', 1, 'already-submitted')
    const response = await request('/v1/image-tasks', { prompt: 'test prompt', model: 'gpt-image-2', n: 1, client_task_id: 'already-submitted' })
    expect(response.status).toBe(202)
    expect((await response.json()).id).toBe(existing.id)
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tasks').get()!.n).toBe(1)
  })
  test('does not let an ineligible Codex account block a valid one', () => {
    account('free-codex'); account('plus-codex')
    db.run("UPDATE accounts SET source='codex',plan='free' WHERE id='free-codex'")
    db.run("UPDATE accounts SET source='codex',plan='Plus' WHERE id='plus-codex'")
    scheduler.submitTask({ owner: 'admin', prompt: 'codex test', model: 'codex-gpt-image-2', n: 1, refs: [] })
    expect(scheduler.claimImage()!.account!.id).toBe('plus-codex')
  })
  test('dispatches a validated Pro Lite account using the same plan policy as submission', () => {
    account('prolite-codex')
    db.run("UPDATE accounts SET source='codex',plan=' ProLite ' WHERE id='prolite-codex'")
    scheduler.submitTask({ owner: 'admin', prompt: 'prolite scheduling', model: 'gpt-image-2.5-sunburst', n: 1, refs: [] })
    expect(scheduler.claimImage()!.account!.id).toBe('prolite-codex')
    expect(store.getAccount('prolite-codex')!.inflight).toBe(1)
  })
  test('explains account source mismatches without asking users to reimport a valid account', async () => {
    account('codex-only')
    db.run("UPDATE accounts SET source='codex',plan='prolite' WHERE id='codex-only'")
    const response = await request('/v1/image-tasks', { model: 'gpt-image-2', prompt: 'source mismatch' })
    expect(response.status).toBe(409)
    expect((await response.json()).error.message).toContain('ChatGPT 网页来源账号')
  })
  test('rejects untrusted image domains and private reference addresses', async () => {
    await expect(validateImageUrl('https://not-allowed.example/image.png')).rejects.toThrow('允许列表')
    saveSettings({ ...defaults, allowedImageHosts: ['127.0.0.1'] })
    await expect(validateImageUrl('https://127.0.0.1/image.png')).rejects.toThrow('私有网络')
  })
})
