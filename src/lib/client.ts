export async function api<T = any>(path: string, data?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', method: method || (data === undefined ? 'GET' : 'POST'), headers: data === undefined ? undefined : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error?.message || '请求失败'), { status: response.status })
  return result
}
export type Account = { id: string; name: string; email: string | null; source: string; plan: string; status: string; quota: number | null; slots: number; inflight: number; success: number; fail: number; last_error: string | null; last_refresh: number | null; cooldown_until: number; hasRefreshToken: boolean }
export type ImageResult = { id: string; status: string; position: number; url: string | null; error: string | null; bytes: number | null; queued_at: number | null; started: number | null; finished: number | null }
export type Task = { id: string; prompt: string; model: string; n: number; status: string; created: number; updated: number; demo: boolean; refs: string[]; completed: number; failed: number; active: number; images: ImageResult[] }
export type ApiKey = { id: string; name: string; prefix: string; enabled: number; created: number; last_used: number | null }
export type Settings = { globalConcurrency: number; taskConcurrency: number; queueLimit: number; jobTimeoutSeconds: number; refreshMinutes: number; storage: 'local' | 'oss'; publicBaseUrl: string; allowedImageHosts: string[]; oss: { region: string; bucket: string; endpoint: string; accessKeyId: string; accessKeySecret: string; prefix: string; urlExpiry: number; hasCredentials: boolean } }
export type Snapshot = { accounts: Account[]; tasks: Task[]; keys: ApiKey[]; settings: Settings; counts: Record<string, number>; delivered: Record<string, number>; hourly: { hour: number; count: number }[]; serverTime: number; baseUrl: string }
export type DeviceAuthorization = { id: string; status: 'pending' | 'exchanging' | 'success' | 'failed' | 'expired' | 'cancelled'; verificationUrl: string; userCode: string; expires: number; pollInterval: number; error: string | null; accountId: string | null; accountStatus: string | null; accountName: string | null }
