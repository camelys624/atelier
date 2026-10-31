import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { open, unlink } from 'node:fs/promises'
import { settings } from './store'
import { withImageTransfer } from './image-transfers'

function privateAddress(value: string): boolean {
  const ip = value.toLowerCase()
  if (ip.includes(':')) {
    if (ip.startsWith('::ffff:')) return privateAddress(ip.slice(7))
    return !/^[23][0-9a-f]{3}:/.test(ip) || ip.startsWith('2001:db8:')
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b))
}
export async function validateImageUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('参考图需要 HTTPS 图片地址')
  const hosts = settings().allowedImageHosts.map(s => s.toLowerCase())
  if (!hosts.length || !hosts.includes(url.hostname.toLowerCase())) throw new Error('参考图域名尚未加入允许列表，请在存储设置中添加你们的 OSS 域名')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true })
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw new Error('参考图地址不能指向私有网络')
  return url
}
export async function fetchReference(value: string, target: string) {
  return withImageTransfer(async () => {
    const url = await validateImageUrl(value)
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
    let file: Awaited<ReturnType<typeof open>> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let size = 0, complete = false
    try {
      if (!response.ok) throw new Error(`读取参考图失败（HTTP ${response.status}）`)
      const type = response.headers.get('content-type')?.split(';')[0] || ''
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error('参考图仅支持 PNG、JPEG、WebP')
      const max = 10 * 1024 * 1024
      if (Number(response.headers.get('content-length')) > max) throw new Error('单张参考图不能超过 10 MB')
      reader = response.body?.getReader()
      if (!reader) throw new Error('参考图内容为空')
      file = await open(target, 'wx', 0o600)
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        size += chunk.length
        if (size > max) throw new Error('单张参考图不能超过 10 MB')
        await file.writeFile(chunk)
      }
      if (!size) throw new Error('参考图内容为空')
      complete = true
    } finally {
      if (reader) await reader.cancel().catch(() => {})
      else await response.body?.cancel().catch(() => {})
      try { await file?.close() }
      finally { if (file && !complete) await unlink(target).catch(() => {}) }
    }
  })
}
