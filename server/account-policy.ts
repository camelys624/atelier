// Tested stable up to 45 concurrent images per account; keep headroom.
export const MAX_ACCOUNT_SLOTS = 30
// Keep admission and dispatch in sync when upstream returns additional plan identifiers.
export const CODEX_IMAGE_PLANS = ['plus', 'team', 'business', 'pro', 'prolite'] as const
export const supportsCodexImages = (plan: string) => (CODEX_IMAGE_PLANS as readonly string[]).includes(plan.trim().toLowerCase())

export function needsAccountRefresh(account: { status: string; inflight: number; last_refresh: number | null; cooldown_until: number }, now: number, refreshMinutes: number) {
  if (account.status === 'disabled' || account.inflight || account.cooldown_until > now) return false
  return (account.status === 'error' && account.cooldown_until > 0) || !account.last_refresh || account.last_refresh < now - refreshMinutes * 60_000
}
