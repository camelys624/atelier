import { db, accounts, adminKey, equal, hash, id, seal, settings, publicSettings, saveSettings, publicAccount, getAccount, getTask, publicTask, taskImages, unseal, type Account, type Task, type Settings, type ImageRow } from './store'
import { refreshAccount, safeError } from './adapter'
import { submitTask, taskFingerprint, retryTask, pump, baseUrl } from './scheduler'
import { imageUrl, imageBase64, testOss } from './storage'
import { validateImageUrl } from './network'
import { normalizeAccount, saveAccount } from './accounts'
import { deviceAuth, DeviceAuthError } from './device-auth'
import { HttpError } from './http'
import { IMAGE_MODELS, MODELS, accountSource, imageBody, prepareReferences, saveReferences, isUploadedReference, normalizeSize, normalizeQuality } from './image-input'
import { MAX_ACCOUNT_SLOTS, supportsCodexImages } from './account-policy'

const json = (data: unknown, status = 200, headers: HeadersInit = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
const bad = (message: string): never => { throw new HttpError(400, message) }
function integer(value: unknown, fallback: number, min: number, max: number) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) bad(`数值必须介于 ${min} 和 ${max} 之间`)
  return n
}
async function body(request: Request) {
  if (Number(request.headers.get('content-length')) > 1024 * 1024) throw new HttpError(413, '请求过大。图片请上传 OSS 后传入地址')
  const reader = request.body?.getReader()
  if (!reader) return {}
  let bytes = 0; const chunks = []
  try {
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 1024 * 1024) throw new HttpError(413, '请求过大。图片请上传 OSS 后传入地址'); chunks.push(next.value) }
  } finally { await reader.cancel().catch(() => {}) }
  try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { return bad('请求需要有效的 JSON') }
}
type Identity = { owner: string; admin: boolean; cookie?: string }
function identity(request: Request): Identity {
  const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
  if (bearer) {
    if (equal(bearer, adminKey)) return { owner: 'admin', admin: true }
    const row = db.query<{ id: string }, [string]>('SELECT id FROM api_keys WHERE key_hash=? AND enabled=1').get(hash(bearer))
    if (row) { db.run('UPDATE api_keys SET last_used=? WHERE id=?', [Date.now(), row.id]); return { owner: row.id, admin: false } }
  } else {
    const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)atelier_session=([^;]+)/)?.[1]
    if (cookie && db.query('SELECT 1 FROM sessions WHERE token_hash=? AND expires>?').get(hash(cookie), Date.now())) return { owner: 'admin', admin: true, cookie }
  }
  throw new HttpError(401, '请登录或使用有效的 API 密钥')
}
const usableAccount = (a: Account) => ['ready', 'refreshing'].includes(a.status) && (a.quota === null || a.quota > 0) && (a.source !== 'codex' || supportsCodexImages(a.plan))
function modelList() {
  const usable = accounts().filter(usableAccount)
  return MODELS.map(model => ({ ...model, accounts: usable.filter(a => a.source === model.source).length }))
}
function checkOrigin(request: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.headers.has('authorization')) return
  const origin = request.headers.get('origin')
  const allowed = new Set([new URL(request.url).origin, baseUrl()])
  if (process.env.NODE_ENV !== 'production') { const port = process.env.DEV_WEB_PORT || '5173'; allowed.add(`http://127.0.0.1:${port}`); allowed.add(`http://localhost:${port}`) }
  if (origin && !allowed.has(origin)) throw new HttpError(403, '请求来源不被允许')
}
async function serialize(task: Task) {
  const data = publicTask(task)
  for (const image of data.images) if (image.status === 'success') image.url = await imageUrl(image)
  return data
}
function ownedTask(taskId: string, who: Identity) {
  const task = getTask(taskId)
  if (!task || (!who.admin && task.owner !== who.owner)) throw new HttpError(404, '任务不存在')
  return task
}
async function createTask(request: Request, input: any, who: Identity) {
  const prompt = String(input.prompt || '').trim()
  if (!prompt || prompt.length > 12_000) return bad('请输入提示词，最多 12000 字符')
  const model = String(input.model || 'gpt-image-2')
  if (!IMAGE_MODELS.includes(model)) return bad(`不支持这个生图模型，可使用 ${IMAGE_MODELS.join('、')}`)
  const size = normalizeSize(input.size, input.aspect_ratio ?? input.aspectRatio), quality = normalizeQuality(input.quality, model)
  if (input.stream) return bad('第一版提供任务轮询接口，暂不支持流式返回')
  if (input.response_format && !['url', 'b64_json'].includes(input.response_format)) return bad('response_format 只支持 url 或 b64_json')
  if (input.output_format && input.output_format !== 'png') return bad('当前仅支持 output_format=png')
  for (const field of ['mask', 'background', 'output_compression', 'input_fidelity']) if (input[field] !== undefined) return bad(`当前尚不支持 ${field} 参数`)
  const n = integer(input.n, 1, 1, 7)
  const demo = !!input.demo && who.admin
  if (input.demo && !who.admin) throw new HttpError(403, '演示仅用于后台测试')
  const { refs, uploads } = await prepareReferences(input)
  if (new URL(request.url).pathname.replace(/\/$/, '').endsWith('/edits') && !refs.length) return bad('图片编辑需要至少一张 image 参考图文件或 OSS 地址')
  const clientId = String(request.headers.get('idempotency-key') || input.client_task_id || '').slice(0, 128)
  if (clientId) {
    const existing = db.query<Task, [string, string]>('SELECT * FROM tasks WHERE owner=? AND client_id=?').get(who.owner, clientId)
    if (existing) {
      if (existing.fingerprint !== taskFingerprint({ prompt, model, size, quality, n, refs, demo })) return bad('这个幂等标识已用于不同请求，请使用新的标识')
      return existing
    }
  }
  for (const reference of refs) if (!isUploadedReference(reference)) await validateImageUrl(reference)
  if (!demo) {
    const source = accountSource(model)
    const pool = accounts().filter(a => a.source === source)
    const others = modelList().filter(m => m.id !== model && m.accounts > 0).map(m => m.id)
    const hint = others.length ? `；当前可用的模型：${others.join('、')}` : ''
    if (!pool.length) throw new HttpError(409, `模型 ${model} 需要 ${source === 'codex' ? 'Codex' : 'ChatGPT 网页'}来源账号，当前账号池没有此来源的账号${hint}`)
    if (!pool.some(usableAccount)) throw new HttpError(409, `没有匹配的可用账号：请检查 ${source === 'codex' ? 'Codex' : 'ChatGPT 网页'}账号的验证状态、额度和会员类型${hint}`)
  }
  await saveReferences(uploads)
  const task = submitTask({ owner: who.owner, prompt, model, size, quality, n, refs, demo, clientId })
  void pump()
  return task
}
let attempts = 0, loginWindow = 0
export async function handleApi(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/$/, '')
  try {
    checkOrigin(request)
    if (path === '/health') return json({ status: 'ok', version: '0.1.0', accounts: accounts().filter(a => a.status === 'ready').length })
    if (path === '/api/auth/login' && request.method === 'POST') {
      if (Date.now() - loginWindow > 60_000) { attempts = 0; loginWindow = Date.now() }
      if (++attempts > 20) throw new HttpError(429, '登录尝试过多，请一分钟后重试')
      const input = await body(request)
      if (!equal(String(input.key || ''), adminKey)) throw new HttpError(401, '管理员密钥不正确')
      const token = crypto.randomUUID() + crypto.randomUUID()
      db.run('INSERT INTO sessions VALUES(?,?)', [hash(token), Date.now() + 7 * 86400_000])
      return json({ ok: true }, 200, { 'Set-Cookie': `atelier_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${baseUrl().startsWith('https:') ? '; Secure' : ''}` })
    }
    const who = identity(request)
    if (path === '/api/auth/session') return json({ admin: who.admin })
    if (path.startsWith('/api/') && !who.admin) throw new HttpError(403, '需要管理员权限')
    const authorizationOwner = hash(who.cookie || request.headers.get('authorization') || who.owner)
    if (path === '/api/accounts/authorize' && request.method === 'POST') return json(await deviceAuth.begin(authorizationOwner), 201)
    const authorizationMatch = path.match(/^\/api\/accounts\/authorize\/([^/]+)$/)
    if (authorizationMatch) {
      const authorization = deviceAuth.get(authorizationMatch[1], authorizationOwner)
      if (!authorization) throw new HttpError(404, '授权会话不存在或已失效，请重新开始')
      if (request.method === 'GET') return json(authorization)
      if (request.method === 'DELETE') return json(deviceAuth.cancel(authorization.id, authorizationOwner))
    }
    if (path === '/api/auth/logout' && request.method === 'POST') {
      if (who.cookie) db.run('DELETE FROM sessions WHERE token_hash=?', [hash(who.cookie)])
      return json({ ok: true }, 200, { 'Set-Cookie': 'atelier_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' })
    }
    if (path === '/api/bootstrap') {
      const allAccounts = accounts(), allTasks = db.query<Task, []>('SELECT * FROM tasks ORDER BY created DESC LIMIT 100').all()
      const keys = db.query('SELECT id,name,prefix,enabled,created,last_used FROM api_keys ORDER BY created DESC').all()
      const counts = db.query<{ status: string; count: number }, []>('SELECT status,COUNT(*) AS count FROM images GROUP BY status').all()
      const delivered = db.query<{ status: string; count: number }, []>("SELECT images.status,COUNT(*) AS count FROM images JOIN tasks ON tasks.id=images.task_id WHERE tasks.demo=0 AND images.status IN ('success','error') GROUP BY images.status").all()
      const hourly = db.query("SELECT CAST(images.finished/3600000 AS INTEGER)*3600000 AS hour,COUNT(*) AS count FROM images JOIN tasks ON tasks.id=images.task_id WHERE tasks.demo=0 AND images.status='success' AND images.finished>? GROUP BY hour ORDER BY hour").all(Date.now() - 24 * 3600_000)
      return json({ accounts: allAccounts.map(publicAccount), tasks: await Promise.all(allTasks.map(serialize)), keys, settings: publicSettings(), counts: Object.fromEntries(counts.map(r => [r.status, r.count])), delivered: Object.fromEntries(delivered.map(r => [r.status, r.count])), hourly, models: modelList(), serverTime: Date.now(), baseUrl: baseUrl() })
    }
    if (path === '/api/accounts' && request.method === 'POST') {
      const input = await body(request)
      const source = input.source === 'codex' ? 'codex' : 'web'
      let items = input.items
      if (typeof items === 'string') {
        try { items = JSON.parse(items) } catch { items = items.split(/\r?\n/).filter((s: string) => s.trim()).map((access_token: string) => ({ access_token })) }
      }
      if (!Array.isArray(items)) items = [items]
      if (!items.length || items.length > 200) return bad('一次可导入 1～200 个账号')
      const prepared = items.map((item: any) => normalizeAccount(item, source))
      let added = 0
      db.transaction(() => {
        for (const item of prepared) if (saveAccount(item).added) added++
      }).immediate()
      return json({ added, updated: prepared.length - added })
    }
    const accountMatch = path.match(/^\/api\/accounts\/([^/]+)(?:\/(refresh))?$/)
    if (accountMatch) {
      const account = getAccount(accountMatch[1]); if (!account) throw new HttpError(404, '账号不存在')
      if (request.method === 'DELETE') {
        if (account.inflight) throw new HttpError(409, '账号正在生成图片，请完成后再删除')
        db.run('DELETE FROM accounts WHERE id=?', [account.id]); return json({ ok: true })
      }
      if (accountMatch[2] && request.method === 'POST') { await refreshAccount(account.id); return json({ ok: true }) }
      if (request.method === 'PATCH') {
        const input = await body(request)
        const status = input.enabled === undefined ? account.status : input.enabled ? 'pending' : 'disabled'
        const name = String(input.name || account.name).slice(0, 80)
        const slots = integer(input.slots, account.slots, 1, MAX_ACCOUNT_SLOTS)
        db.run('UPDATE accounts SET name=?,slots=?,status=? WHERE id=?', [name, slots, status, account.id])
        if (input.enabled) void refreshAccount(account.id).catch(() => {})
        return json({ ok: true })
      }
    }
    if (path === '/api/keys' && request.method === 'POST') {
      const input = await body(request), name = String(input.name || '').trim().slice(0, 80)
      if (!name) return bad('请输入密钥名称')
      const key = `sk-atelier-${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().slice(0, 8)}`
      db.run('INSERT INTO api_keys(id,name,key_hash,prefix,created) VALUES(?,?,?,?,?)', [id('key'), name, hash(key), key.slice(0, 16), Date.now()])
      return json({ key })
    }
    const keyMatch = path.match(/^\/api\/keys\/([^/]+)$/)
    if (keyMatch && request.method === 'DELETE') { db.run('UPDATE api_keys SET enabled=0 WHERE id=?', [keyMatch[1]]); return json({ ok: true }) }
    if (path === '/api/settings' && request.method === 'POST') {
      const input = await body(request), previous = settings()
      const value: Settings = { ...previous,
        queueLimit: integer(input.queueLimit, previous.queueLimit, 10, 2000),
        jobTimeoutSeconds: integer(input.jobTimeoutSeconds, previous.jobTimeoutSeconds, 60, 1800),
        refreshMinutes: integer(input.refreshMinutes, previous.refreshMinutes, 1, 60),
        storage: input.storage === 'oss' ? 'oss' : 'local', publicBaseUrl: String(input.publicBaseUrl || '').trim(),
        allowedImageHosts: (Array.isArray(input.allowedImageHosts) ? input.allowedImageHosts : []).map((v: unknown) => String(v).trim().toLowerCase()).filter(Boolean),
        oss: { ...previous.oss, region: String(input.oss?.region || '').trim(), bucket: String(input.oss?.bucket || '').trim(), endpoint: String(input.oss?.endpoint || '').trim(), prefix: String(input.oss?.prefix || 'atelier').trim(), urlExpiry: integer(input.oss?.urlExpiry, previous.oss.urlExpiry, 60, 86400), accessKeyId: input.oss?.accessKeyId && !String(input.oss.accessKeyId).startsWith('****') ? String(input.oss.accessKeyId).trim() : previous.oss.accessKeyId, accessKeySecret: input.oss?.accessKeySecret ? String(input.oss.accessKeySecret).trim() : previous.oss.accessKeySecret },
      }
      if (value.publicBaseUrl && !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/.test(value.publicBaseUrl)) return bad('图片公开域名需要 HTTPS 地址')
      if (value.oss.endpoint && !/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/?$/.test(value.oss.endpoint)) return bad('OSS Endpoint 需要 HTTPS 域名')
      if (value.storage === 'oss' && (!value.oss.region || !value.oss.bucket || !value.oss.accessKeyId || !value.oss.accessKeySecret)) return bad('使用 OSS 前请补全存储配置')
      saveSettings(value); return json({ ok: true })
    }
    if (path === '/api/settings/test-oss' && request.method === 'POST') return json(await testOss())
    if (path === '/v1/models') return json({ object: 'list', data: modelList().map(model => ({ id: model.id, object: 'model', owned_by: 'atelier', available: model.accounts > 0 })) })
    if (['/api/tasks', '/v1/image-tasks', '/v1/images/generations', '/v1/images/edits'].includes(path) && request.method === 'POST') {
      const input = await imageBody(request, body)
      const task = await createTask(request, input, who)
      if (path.startsWith('/api/') || path === '/v1/image-tasks' || input.async === true) return json(await serialize(task), 202)
      // The standard synchronous endpoint is bounded; its task continues if the caller disconnects.
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        const current = getTask(task.id)!
        if (['success', 'partial', 'error', 'cancelled'].includes(current.status)) {
          const value = await serialize(current)
          const images = value.images.filter(i => i.status === 'success')
          if (!images.length) return json({ error: { message: value.images.find(i => i.error)?.error || '图片生成失败', type: 'server_error' }, task_id: task.id }, 502)
          const format = input.response_format || (path.endsWith('/edits') ? 'b64_json' : 'url')
          try {
            const data = []
            for (const image of images) {
              if (format === 'url') data.push({ url: image.url })
              else data.push({ b64_json: await imageBase64(taskImages(task.id).find(row => row.id === image.id)!) })
            }
            return json({ created: Math.floor(task.created / 1000), data, task_id: task.id, ...(current.status === 'partial' ? { partial: true, failed: value.failed } : {}) })
          } catch (error) {
            return json({ error: { message: safeError(error), type: 'server_error' }, task_id: task.id }, 502)
          }
        }
        await Bun.sleep(500)
      }
      return json({ error: { message: '等待超时，任务仍在执行，请查询 task_id，避免重复提交', type: 'timeout' }, task_id: task.id }, 504)
    }
    const taskMatch = path.match(/^\/(?:api\/tasks|v1\/image-tasks)\/([^/]+)(?:\/(retry|cancel))?$/)
    if (taskMatch) {
      const task = ownedTask(taskMatch[1], who)
      if (request.method === 'GET') return json(await serialize(task))
      if (request.method === 'POST' && taskMatch[2] === 'retry') { retryTask(task.id); return json({ ok: true }) }
      if (request.method === 'POST' && taskMatch[2] === 'cancel') {
        db.run("UPDATE images SET status='cancelled',finished=? WHERE task_id=? AND status='queued'", [Date.now(), task.id])
        db.run("UPDATE tasks SET status='cancelled',updated=? WHERE id=?", [Date.now(), task.id]); return json({ ok: true })
      }
    }
    throw new HttpError(404, '接口不存在')
  } catch (error) {
    return json({ error: { message: safeError(error), type: 'request_error' } }, error instanceof HttpError || error instanceof DeviceAuthError ? error.status : 400)
  }
}
