import { resolve } from 'node:path'
import { open, rename, unlink } from 'node:fs/promises'
import { unseal, dataDir, settings, hash, type Account } from './store'
import { imageMime } from './image-input'

export class OpenAIRequestError extends Error { constructor(public status: number, message: string) { super(message) } }

// Prepare a sized file: Bun 1.3's HTTPS proxy upload can drop a ReadableStream
// request. Write incrementally to keep multi-image inputs out of a single buffer.
// Explicit filenames also avoid Bun's FormData leaking a BunFile's local path.
async function multipartImages(fields: Record<string, string | number>, paths: string[], target: string) {
  const boundary = `atelier-${crypto.randomUUID()}`, encoder = new TextEncoder()
  const parts: Array<{ bytes: Uint8Array } | { file: ReturnType<typeof Bun.file> }> = []
  for (const [key, value] of Object.entries(fields)) parts.push({ bytes: encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`) })
  for (const [index, path] of paths.entries()) {
    const file = Bun.file(path), mime = imageMime(new Uint8Array(await file.slice(0, 12).arrayBuffer()))
    const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
    parts.push({ bytes: encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference-${index}.${extension}"\r\nContent-Type: ${mime}\r\n\r\n`) }, { file }, { bytes: encoder.encode('\r\n') })
  }
  parts.push({ bytes: encoder.encode(`--${boundary}--\r\n`) })
  const output = await open(target, 'wx', 0o600)
  try {
    for (const part of parts) {
      if ('bytes' in part) await output.writeFile(part.bytes)
      else {
        const reader = part.file.stream().getReader()
        try { for (let next = await reader.read(); !next.done; next = await reader.read()) await output.writeFile(next.value) }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      }
    }
  } finally { await output.close() }
  const body = Bun.file(target)
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.size) } }
}

// One upstream request per image. Never automatically replay a paid generation.
export async function generateOpenAIImage(account: Account, request: { model: string; prompt: string; size: string; quality: string; images: string[]; imageId: string; attempt: number; owner: string }) {
  const apiKey = unseal(account.secret).api_key as string
  if (!apiKey) throw new Error('请在账号池中更新这个 OpenAI API Key')
  const output = resolve(dataDir, 'spool', `${request.imageId}.${request.attempt}.png`), partial = output.replace(/\.png$/, '.part')
  const fields = { model: request.model, prompt: request.prompt, n: 1, size: request.size, quality: request.quality, output_format: 'png', safety_identifier: hash(request.owner) }
  let body: BodyInit, endpoint = 'generations'
  let requestFile: string | undefined
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  try {
    if (request.images.length) {
      endpoint = 'edits'
      requestFile = `${output}.${crypto.randomUUID()}.request`
      const multipart = await multipartImages(fields, request.images, requestFile)
      body = multipart.body
      Object.assign(headers, multipart.headers)
    } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(fields) }
    const response = await fetch(`https://api.openai.com/v1/images/${endpoint}`, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(settings().jobTimeoutSeconds * 1000) })
    if (!response.ok) {
      let message = ''
      try { const error = await response.json() as any; message = typeof error?.error?.message === 'string' ? error.error.message : '' } catch {}
      message = message.split(apiKey).join('[redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 250)
      throw new OpenAIRequestError(response.status, `OpenAI API 请求失败（HTTP ${response.status}）${message ? `：${message}` : ''}`)
    }
    const result = await response.json() as any, encoded = result?.data?.[0]?.b64_json
    if (typeof encoded !== 'string' || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error('OpenAI API 未返回有效的图片结果')
    const bytes = Buffer.from(encoded, 'base64')
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('OpenAI API 未返回 PNG 图片')
    await Bun.write(partial, bytes)
    await rename(partial, output)
    return { path: output, mime: 'image/png', bytes: bytes.length }
  } catch (error) {
    await unlink(partial).catch(() => {})
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('OpenAI API 请求超时，上游可能已生成图片，请确认后再手动重试')
    if (error instanceof OpenAIRequestError) throw error
    const message = String(error instanceof Error ? error.message : error).split(apiKey).join('[redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    if (/socket connection was closed unexpectedly|ECONNRESET|ECONNABORTED|socket hang up/i.test(message)) throw new Error('OpenAI API 连接中断，未收到完整响应；上游可能已处理请求，请确认后手动重试')
    throw new Error(message)
  } finally { if (requestFile) await unlink(requestFile).catch(() => {}) }
}
