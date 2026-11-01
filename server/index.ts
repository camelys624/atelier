import { resolve } from 'node:path'
import { db, recoverInterruptedTasks, type ImageRow } from './store'
import { handleApi } from './api'
import { startScheduler, stopScheduler } from './scheduler'
import { stopAdapters } from './adapter'
import { startCleanup, stopCleanup } from './retention'
import { deviceAuth } from './device-auth'
import { MAX_UPLOAD_BYTES } from './image-input'

const publicRoot = resolve('dist/client')
const server = Bun.serve({
  hostname: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3080),
  idleTimeout: 240, maxRequestBodySize: MAX_UPLOAD_BYTES,
  async fetch(request) {
    const url = new URL(request.url)
    if (/^\/(api|v1)(\/|$)/.test(url.pathname) || url.pathname === '/health') return handleApi(request)
    if (url.pathname.startsWith('/media/')) {
      const imageId = url.pathname.slice(7)
      if (!/^img_[a-f0-9]{24}$/.test(imageId)) return new Response('Not found', { status: 404 })
      const image = db.query<ImageRow, [string, string]>('SELECT * FROM images WHERE id=? AND status=?').get(imageId, 'success')
      if (!image?.local_path) return new Response('Not found', { status: 404 })
      const file = Bun.file(image.local_path)
      if (!await file.exists()) return new Response('Not found', { status: 404 })
      return new Response(file, { headers: { 'Content-Type': image.mime || 'image/png', 'Cache-Control': 'public,max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } })
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 })
    let decoded: string
    try { decoded = decodeURIComponent(url.pathname) } catch { return new Response('Bad path', { status: 400 }) }
    const path = resolve(publicRoot, '.' + decoded)
    if (!path.startsWith(publicRoot + '/') && path !== publicRoot) return new Response('Not found', { status: 404 })
    const file = Bun.file(path)
    if (await file.exists() && !decoded.endsWith('/')) return new Response(request.method === 'HEAD' ? null : file, { headers: { 'Content-Type': file.type, 'Cache-Control': decoded.startsWith('/assets/') ? 'public,max-age=31536000,immutable' : 'no-cache' } })
    if (decoded.startsWith('/assets/')) return new Response('Not found', { status: 404 })
    const shell = Bun.file(resolve(publicRoot, '_shell.html'))
    if (await shell.exists()) return new Response(request.method === 'HEAD' ? null : shell, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } })
    return new Response('管理后台尚未构建。运行 bun run build，或使用 bun run dev。', { status: 503 })
  },
})
// Acquire the listening port before recovery, so an accidental second launch cannot reset live jobs.
recoverInterruptedTasks()
deviceAuth.start()
startScheduler()
startCleanup()
console.log(`Atelier 已启动：http://${server.hostname}:${server.port}`)
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { deviceAuth.stop(); stopScheduler(); stopCleanup(); stopAdapters(); server.stop(true); db.close(); process.exit(0) })
