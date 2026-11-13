// Tested stable up to 45 concurrent images per account; keep headroom.
export const MAX_ACCOUNT_SLOTS = 30
// Keep admission and dispatch in sync when upstream returns additional plan identifiers.
export const CODEX_IMAGE_PLANS = ['plus', 'team', 'business', 'pro', 'prolite'] as const
export const supportsCodexImages = (plan: string) => (CODEX_IMAGE_PLANS as readonly string[]).includes(plan.trim().toLowerCase())

// A Codex OAuth token also carries the chatgpt.com backend scope, so a web-model task (gpt-image-2) can run on a
// Codex account through the web conversation protocol without consuming Codex image quota. Codex models still
// require a Codex account, and OpenAI API keys only serve OpenAI API models.
export const servesSource = (account: { source: string }, source: string) => account.source === source || (source === 'web' && account.source === 'codex')

/** Availability counts accounts with this predicate; dispatch repeats the same rules in its SQL filter. */
export const canRunSource = (account: { source: string; status: string; quota: number | null; plan: string }, source: string) =>
  ['ready', 'refreshing'].includes(account.status) && (account.quota === null || account.quota > 0) && servesSource(account, source) && (source !== 'codex' || supportsCodexImages(account.plan))

export function needsAccountRefresh(account: { source?: string; status: string; inflight: number; last_refresh: number | null; cooldown_until: number }, now: number, refreshMinutes: number) {
  if (account.source === 'openai' || account.status === 'disabled' || account.inflight || account.cooldown_until > now) return false
  return (account.status === 'error' && account.cooldown_until > 0) || !account.last_refresh || account.last_refresh < now - refreshMinutes * 60_000
}
