import { useState, type FormEvent } from 'react'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { api, type Account } from '@/lib/client'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field } from './views/shared'

export function OpenAIAccountForm({ account, complete, close }: { account: Account | null; complete: () => Promise<void>; close: () => void }) {
  const [name, setName] = useState(account?.name || ''), [key, setKey] = useState(''), [slots, setSlots] = useState(String(account?.slots || 5)), [busy, setBusy] = useState(false)
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await api('/api/accounts', { source: 'openai', ...(account ? { accountId: account.id } : {}), items: { ...(name.trim() ? { name: name.trim() } : {}), api_key: key.trim(), slots: Number(slots) } })
      toast.success(account ? 'API Key 已更新' : 'API Key 已加入账号池')
      await complete(); close()
    } catch (error: any) { toast.error(error.message) }
    finally { setBusy(false) }
  }
  return <form className="mt-6 space-y-5" onSubmit={save}>
    <div className="rounded-lg bg-accent-soft px-4 py-3 text-xs leading-6 text-muted-foreground">每把 Key 单独设置并发，系统按空闲名额分配 OpenAI API 模型的任务。名称用于区分不同密钥。</div>
    <Field className="block" label="API Key 名称（可选）"><Input value={name} onChange={event => setName(event.target.value)} placeholder="例如 项目 A / 备用 Key" maxLength={80} disabled={busy} autoFocus /></Field>
    <Field className="block" label="OpenAI API Key" help={account ? `当前密钥尾号 ${account.keySuffix || '••••'}。留空保留，填写新 Key 可替换。` : '只发送到 OpenAI 官方接口，加密保存后不会返回页面。'}><Input type="password" value={key} onChange={event => setKey(event.target.value)} required={!account} disabled={busy} placeholder={account ? '留空保留现有密钥' : 'sk-…'} autoComplete="new-password" spellCheck={false} maxLength={512} /></Field>
    <Field className="block" label="并发上限" help="每把 Key 支持 1～30 个并发，按你的上游额度设置。"><Input type="number" min={1} max={30} required value={slots} disabled={busy} onChange={event => setSlots(event.target.value)} /></Field>
    {account?.status === 'disabled' && <p className="text-xs text-muted-foreground">更新后仍保持停用，可在账号池中启用。</p>}
    <p className="flex items-start gap-2 border-t pt-4 text-xs leading-5 text-muted-foreground"><ShieldCheck size={13} className="mt-0.5 shrink-0" />密钥格式校验后加入调度，实际模型权限和额度以上游调用结果为准。</p>
    <div className="flex justify-end"><Button type="submit" disabled={busy || (!account && !key.trim())}>{busy ? <Loader2 className="animate-spin" /> : <KeyRound />}{account ? '保存 API Key' : '添加 API Key'}</Button></div>
  </form>
}
