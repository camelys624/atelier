// Bound image I/O independently of account generation slots. Waiting for upstream does not hold this permit.
const limit = Math.max(1, Math.min(32, Number.parseInt(process.env.IMAGE_TRANSFER_CONCURRENCY || '', 10) || 4))
let active = 0
const waiting: Array<() => void> = []

export async function withImageTransfer<T>(run: () => Promise<T>): Promise<T> {
  if (active < limit) active++
  else await new Promise<void>(resolve => waiting.push(resolve))
  try { return await run() }
  finally {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}
