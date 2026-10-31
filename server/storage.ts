import OSS from 'ali-oss'
import { resolve } from 'node:path'
import { stat, unlink } from 'node:fs/promises'
import { settings, type ImageRow } from './store'
import { withImageTransfer } from './image-transfers'

export function ossClient() {
  const s = settings(), o = s.oss
  if (!o.region || !o.bucket || !o.accessKeyId || !o.accessKeySecret) throw new Error('请先填写完整的 OSS 配置')
  if (o.endpoint && !/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/?$/.test(o.endpoint)) throw new Error('OSS Endpoint 必须是 HTTPS 域名')
  return new OSS({ region: o.region, bucket: o.bucket, accessKeyId: o.accessKeyId, accessKeySecret: o.accessKeySecret, ...(o.endpoint ? { endpoint: o.endpoint } : {}), secure: true, timeout: '60s' })
}
export async function persistImage(image: ImageRow, baseUrl: string) {
  if (!image.local_path) throw new Error('本地结果文件不存在')
  const s = settings()
  if (s.storage === 'local') return { url: `${baseUrl}/media/${image.id}`, key: '' }
  const client = ossClient()
  const prefix = s.oss.prefix.replace(/^\/+|\/+$/g, '') || 'atelier'
  const extension = image.mime === 'image/svg+xml' ? 'svg' : 'png'
  const key = image.object_key || `${prefix}/${new Date().toISOString().slice(0, 10)}/${image.task_id}/${image.id}.${extension}`
  // Stream from disk; never hold the whole seven-image task in Bun memory.
  await withImageTransfer(() => client.put(key, resolve(image.local_path!), { headers: { 'Content-Type': image.mime || 'image/png' } }))
  const url = s.publicBaseUrl ? `${s.publicBaseUrl.replace(/\/$/, '')}/${key}` : await client.signatureUrl(key, { expires: s.oss.urlExpiry })
  return { url, key }
}
export async function imageUrl(image: Pick<ImageRow, 'url' | 'object_key'>) {
  const s = settings()
  if (!image.object_key || s.storage !== 'oss' || s.publicBaseUrl) return image.url
  return ossClient().signatureUrl(image.object_key, { expires: s.oss.urlExpiry })
}
export async function imageBase64(image: Pick<ImageRow, 'local_path' | 'object_key'>) {
  // Read the stored object directly; never fetch a caller-controlled result URL.
  if (image.object_key) {
    const result = await ossClient().get(image.object_key)
    return Buffer.from(result.content).toString('base64')
  }
  if (!image.local_path || !await Bun.file(image.local_path).exists()) throw new Error('图片结果文件不存在')
  return Buffer.from(await Bun.file(image.local_path).arrayBuffer()).toString('base64')
}
export async function testOss() {
  const client = ossClient(), key = `${settings().oss.prefix || 'atelier'}/.connection-test-${crypto.randomUUID()}.txt`
  await client.put(key, Buffer.from('atelier storage test'))
  await client.get(key)
  await client.delete(key)
  return { ok: true, message: 'OSS 写入、读取、删除均成功' }
}
export async function cleanupUploadedFile(image: ImageRow) {
  if (settings().storage === 'oss' && image.local_path) await unlink(image.local_path).catch(() => {})
}
