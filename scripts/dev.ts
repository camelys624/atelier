import { createServer } from 'node:net'
// Vite falls back to another port when 5173 is taken; pick it up front so the API can allow that origin.
const free = (port: number): Promise<number> => new Promise(resolve => { const server = createServer().once('error', () => resolve(free(port + 1))).listen(port, '127.0.0.1', () => server.close(() => resolve(port))) })
const port = await free(Number(process.env.WEB_PORT) || 5173)
const env = { ...process.env, DEV_WEB_PORT: String(port) }
const children = [Bun.spawn(['bun', '--watch', 'server/index.ts'], { env, stdout: 'inherit', stderr: 'inherit' }), Bun.spawn(['bun', '--bun', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { env, stdout: 'inherit', stderr: 'inherit' })]
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { children.forEach(c => c.kill()); process.exit() })
await Promise.race(children.map(c => c.exited))
children.forEach(c => c.kill())
export {}
