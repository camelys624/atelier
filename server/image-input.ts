import { mkdir, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dataDir } from './store'
import { HttpError } from './http'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 72 * 1024 * 1024
// Each model is served only by accounts of one source: ChatGPT web accounts cannot run Codex models, and vice versa.
export const MODELS = [
  { id: 'gpt-image-2', name: 'GPT Image 2', source: 'web', description: '使用 ChatGPT 网页账号生成' },
  { id: 'codex-gpt-image-2', name: 'GPT Image 2', source: 'codex', description: '使用 Codex 账号生成' },
  { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', source: 'codex', description: '使用 Codex 账号生成，quality 额外支持 xhigh、max' },
] as const satisfies readonly { id: string; name: string; source: 'web' | 'codex'; description: string }[]
export const IMAGE_MODELS: string[] = MODELS.map(m => m.id)
export const accountSource = (model: string) => MODELS.find(m => m.id === model)?.source ?? 'codex'
// Clients send many sizes ("1792x1024", "16:9", "2K"); snap each to the closest output we can produce instead of rejecting it.
const SIZES = [['1024x1024', 1], ['1536x1024', 3 / 2], ['1024x1536', 2 / 3]] as const
const parseRatio = (value: unknown) => {
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*[x×*:/]\s*(\d+(?:\.\d+)?)$/i)
  const ratio = match ? Number(match[1]) / Number(match[2]) : NaN
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined
}
export function normalizeSize(size: unknown, aspectRatio?: unknown) {
  const ratio = parseRatio(size) ?? parseRatio(aspectRatio)
  if (ratio === undefined) return String(size ?? '').trim().toLowerCase() === 'auto' ? 'auto' : '1024x1024'
  return SIZES.reduce((best, item) => Math.abs(Math.log(item[1] / ratio)) < Math.abs(Math.log(best[1] / ratio)) ? item : best)[0]
}
const QUALITY_ALIASES: Record<string, string> = { standard: 'medium', normal: 'medium', hd: 'high', ultra: 'xhigh', highest: 'max', best: 'max' }
export function normalizeQuality(quality: unknown, model: string) {
  const text = String(quality ?? '').trim().toLowerCase()
  const value = QUALITY_ALIASES[text] ?? text
  if (['auto', 'low', 'medium', 'high'].includes(value)) return value
  if (['xhigh', 'max'].includes(value)) return model === 'gpt-image-2.5-sunburst' ? value : 'high'
  return 'auto'
}
export const isUploadedReference =(value: string) => /^upload:[a-f0-9]{64}$/.test(value)
export const referencePath = (value: string) => {
  if (!isUploadedReference(value)) throw new Error('无效的上传图片标识')
  return resolve(dataDir, 'references', value.slice(7))
}
type Upload = { reference: string; file: File }

export async function imageBody(request: Request, readJson: (request: Request) => Promise<any>) {
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return readJson(request)
  if (Number(request.headers.get('content-length')) > MAX_UPLOAD_BYTES) throw new HttpError(413, '上传请求不能超过 72 MB')
  let bytes = 0, exceeded = false
  const stream = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.length
      if (bytes > MAX_UPLOAD_BYTES) { exceeded = true; throw new HttpError(413, '上传请求不能超过 72 MB') }
      controller.enqueue(chunk)
    },
  }))
  let form: FormData
  try { form = await new Response(stream, { headers: { 'Content-Type': contentType } }).formData() }
  catch { throw new HttpError(exceeded ? 413 : 400, exceeded ? '上传请求不能超过 72 MB' : '无效的图片上传表单，请使用 multipart/form-data') }
  const input: Record<string, any> = Object.create(null), images: FormDataEntryValue[] = []
  for (const [key, value] of form) {
    if (['image', 'image[]'].includes(key)) { images.push(value); continue }
    if (value instanceof File) throw new HttpError(400, `不支持文件字段 ${key}，请使用 image`)
    if (Object.hasOwn(input, key)) throw new HttpError(400, `字段 ${key} 不能重复`)
    if (value.length > 32_000) throw new HttpError(400, `字段 ${key} 过长`)
    if (['image_urls', 'images'].includes(key)) {
      try { input[key] = JSON.parse(value) } catch { throw new HttpError(400, `${key} 必须是 JSON 数组`) }
    } else if (['async', 'demo', 'stream'].includes(key)) {
      if (!['true', 'false'].includes(value)) throw new HttpError(400, `${key} 必须是 true 或 false`)
      input[key] = value === 'true'
    } else input[key] = value
  }
  if (images.length) input.image = images
  return input
}
export function imageMime(bytes: Uint8Array) {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') return 'image/webp'
  throw new HttpError(400, '参考图内容必须是 PNG、JPEG 或 WebP 图片')
}
export async function prepareReferences(input: any): Promise<{ refs: string[]; uploads: Upload[] }> {
  const candidates = [input.image, input.image_urls, input.images, input.image_url].filter(value => value !== undefined && value !== null)
  if (candidates.length > 1) throw new HttpError(400, 'image、image_urls、images、image_url 请只使用其中一种')
  const raw = candidates[0] ?? []
  const images = Array.isArray(raw) ? raw : [raw]
  if (images.length > 7) throw new HttpError(400, '最多支持 7 张参考图')
  const refs: string[] = [], uploads: Upload[] = []
  for (const image of images) {
    if (image instanceof File) {
      if (!image.size) throw new HttpError(400, '上传的参考图不能为空')
      if (image.size > MAX_IMAGE_BYTES) throw new HttpError(413, '单张参考图不能超过 10 MB')
      imageMime(new Uint8Array(await image.slice(0, 12).arrayBuffer()))
      const digest = new Bun.CryptoHasher('sha256').update(await image.arrayBuffer()).digest('hex')
      const reference = `upload:${digest}`
      refs.push(reference); uploads.push({ reference, file: image })
    } else {
      const reference = typeof image === 'string' ? image : image?.image_url || image?.url
      if (typeof reference !== 'string' || !reference.startsWith('https://')) throw new HttpError(400, '参考图需要上传图片文件，或使用 HTTPS 图片地址')
      refs.push(reference)
    }
  }
  return { refs, uploads }
}
export async function saveReferences(uploads: Upload[]) {
  if (!uploads.length) return
  await mkdir(resolve(dataDir, 'references'), { recursive: true, mode: 0o700 })
  for (const { reference, file } of uploads) {
    const path = referencePath(reference)
    if (await Bun.file(path).exists()) continue
    const temporary = `${path}.${crypto.randomUUID()}.part`
    try { await Bun.write(temporary, file); await rename(temporary, path) }
    finally { await unlink(temporary).catch(() => {}) }
  }
}
export async function uploadedReferenceFile(value: string) {
  const path = referencePath(value), file = Bun.file(path)
  if (!await file.exists()) throw new Error('上传的参考图文件不存在，请重新提交图片')
  if (file.size > MAX_IMAGE_BYTES) throw new Error('单张参考图不能超过 10 MB')
  return path
}
export async function uploadedReference(value: string) {
  const bytes = new Uint8Array(await Bun.file(await uploadedReferenceFile(value)).arrayBuffer())
  return `data:${imageMime(bytes)};base64,${Buffer.from(bytes).toString('base64')}`
}
