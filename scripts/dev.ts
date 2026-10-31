const children = [Bun.spawn(['bun', '--watch', 'server/index.ts'], { stdout: 'inherit', stderr: 'inherit' }), Bun.spawn(['bun', 'run', 'dev:web'], { stdout: 'inherit', stderr: 'inherit' })]
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { children.forEach(c => c.kill()); process.exit() })
await Promise.race(children.map(c => c.exited))
children.forEach(c => c.kill())
export {}
