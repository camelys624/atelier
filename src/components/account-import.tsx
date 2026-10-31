import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, CheckCheck, ChevronRight, Copy, ExternalLink, FileJson, KeyRound, Loader2, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, type DeviceAuthorization } from '@/lib/client'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input, Textarea } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

const cacheKey = 'atelier_device_authorization'
const isPending = (session: DeviceAuthorization | null) => !!session && ['pending', 'exchanging'].includes(session.status)
export function AccountImportDialog({ open, onOpenChange, complete }: { open: boolean; onOpenChange: (value: boolean) => void; complete: () => Promise<void> }) {
  const [mode, setMode] = useState<'authorize' | 'manual'>('authorize')
  const [session, setSession] = useState<DeviceAuthorization | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now())
  const [source, setSource] = useState('web'), [items, setItems] = useState('')
  const file = useRef<HTMLInputElement>(null), openRef = useRef(open), sessionRef = useRef(session), completed = useRef('')
  openRef.current = open; sessionRef.current = session
  function remember(value: DeviceAuthorization) {
    sessionRef.current = value; setSession(value)
    if (isPending(value)) sessionStorage.setItem(cacheKey, value.id)
    else sessionStorage.removeItem(cacheKey)
  }
  useEffect(() => {
    if (!open) return
    let disposed = false
    const existing = sessionStorage.getItem(cacheKey)
    if (existing) void api<DeviceAuthorization>(`/api/accounts/authorize/${existing}`).then(value => { if (!disposed) remember(value) }).catch(() => { sessionStorage.removeItem(cacheKey) })
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { disposed = true; clearInterval(timer) }
  }, [open])
  useEffect(() => {
    if (!open || !session || !isPending(session)) return
    let disposed = false, timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const value = await api<DeviceAuthorization>(`/api/accounts/authorize/${session!.id}`)
        if (disposed) return
        remember(value); setError('')
        if (value.status === 'success' && completed.current !== value.id) { completed.current = value.id; await complete(); toast.success('授权完成，账号凭证已加密保存') }
        if (isPending(value)) timer = setTimeout(poll, 2000)
      } catch (error: any) {
        if (disposed) return
        setError(error.status === 404 ? '授权会话已失效，请重新开始' : '暂时无法读取授权状态，正在重试…')
        if (error.status !== 404) timer = setTimeout(poll, 3000)
        else { sessionStorage.removeItem(cacheKey); setSession(null) }
      }
    }
    timer = setTimeout(poll, 1000)
    return () => { disposed = true; clearTimeout(timer) }
  }, [open, session?.id])
  async function cancelPending() {
    const current = sessionRef.current
    if (isPending(current)) await api(`/api/accounts/authorize/${current!.id}`, undefined, 'DELETE')
    sessionStorage.removeItem(cacheKey); sessionRef.current = null; setSession(null)
  }
  async function close() {
    try { await cancelPending(); setError(''); setItems(''); onOpenChange(false) }
    catch { setError('未能取消等待，请检查连接后重试'); toast.error('取消授权失败，窗口暂时保留') }
  }
  async function begin() {
    setBusy(true); setError('')
    try {
      if (isPending(sessionRef.current)) await cancelPending()
      const value = await api<DeviceAuthorization>('/api/accounts/authorize', {})
      if (!openRef.current) { await api(`/api/accounts/authorize/${value.id}`, undefined, 'DELETE'); return }
      remember(value)
    } catch (error: any) { if (openRef.current) setError(error.message) }
    finally { setBusy(false) }
  }
  async function copyCode() {
    try { await navigator.clipboard.writeText(session!.userCode); toast.success('设备码已复制，请到官方页面输入') }
    catch { toast.error('无法复制，请手动输入上方设备码') }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true)
    try { const result = await api('/api/accounts', { source, items }); toast.success(`新增 ${result.added} 个账号，更新 ${result.updated} 个账号`); setItems(''); onOpenChange(false); await complete() }
    catch (error: any) { toast.error(error.message) }
    finally { setBusy(false) }
  }
  const seconds = Math.max(0, Math.ceil(((session?.expires || now) - now) / 1000))
  const succeeded = session?.status === 'success'
  const failed = session && ['failed', 'expired', 'cancelled'].includes(session.status)
  return <Dialog open={open} onOpenChange={value => value ? onOpenChange(true) : void close()}><DialogContent className="!max-w-[590px]">
    <DialogTitle className="text-xl font-semibold">添加账号</DialogTitle>
    <DialogDescription className="mt-2 text-xs leading-6 text-muted-foreground">通过官方页面授权，登录完成后自动加入账号池。</DialogDescription>
    <div className="mb-6 mt-6 flex gap-5 border-b text-xs">
      {[['authorize', '授权登录'], ['manual', '手动导入']].map(([value, title]) => <button key={value} type="button" disabled={busy} onClick={async () => { if (value === mode) return; try { await cancelPending(); setError(''); setMode(value as typeof mode) } catch { toast.error('请先取消当前授权，再切换方式') } }} className={cn('flex items-center gap-2 border-b-2 pb-3 transition-colors', mode === value ? 'border-[#8b9674] text-[#606a52]' : 'border-transparent text-[#a8b09b]')}>{value === 'authorize' ? <KeyRound size={13} /> : <FileJson size={13} />}{title}{value === 'authorize' && <span className="rounded bg-[#eef2e7] px-1.5 py-0.5 text-[8px] text-[#82946b]">推荐</span>}</button>)}
    </div>
    {mode === 'authorize' ? <div>
      {succeeded ? <div className="py-4 text-center"><span className="mx-auto mb-5 flex size-14 items-center justify-center rounded-full bg-[#edf3e6] text-[#81976b]"><CheckCheck size={25} /></span><h3 className="text-lg font-medium">授权已完成</h3><p className="mt-2 text-sm text-[#6f7c61]">{session.accountName || '账号已加入号池'}</p><p className="mx-auto mt-3 max-w-80 text-[11px] leading-6 text-muted-foreground">登录与续期凭证已加密保存。<br />{session.accountStatus === 'ready' ? '账号验证已完成，可以参与 Codex 图片任务。' : session.accountStatus === 'error' ? '上游可用性验证未通过，请在账号池查看原因并刷新。' : session.accountStatus === 'disabled' ? '这个账号仍保持停用状态，可在账号池中启用。' : '正在继续验证账号套餐与图片权限，请在账号池查看状态。'}</p><Button className="mt-6" onClick={async () => { await complete(); void close() }}>查看账号池<ChevronRight /></Button></div>
      : <>
        <div className="flex items-start gap-3 rounded-xl border border-[#e1e6d8] bg-[#f6f8f1] p-4"><span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#e7eddd] text-[#879772]"><ShieldCheck size={17} /></span><div><p className="text-xs font-medium text-[#667557]">Codex 设备码授权</p><p className="mt-1.5 text-[11px] leading-5 text-[#939e86]">在 OpenAI 官方页面登录并确认。凭证将加密保存在本服务，作为 Codex 账号参与调度。</p></div></div>
        {session && isPending(session) ? <div className="mt-6">
          <div className="mb-3 flex items-center justify-between text-[11px]"><span className="text-[#7b866e]">在官方页面输入这组一次性设备码</span><span className="font-mono text-[#a0aa95]">{Math.floor(seconds / 60).toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')} 后过期</span></div>
          <div className="flex items-center justify-between rounded-xl border bg-[#fafbf8] px-5 py-5"><code className="font-mono text-[29px] font-semibold tracking-[5px] text-[#485340]">{session.userCode}</code><Button size="icon" variant="ghost" aria-label="复制设备码" onClick={() => void copyCode()}><Copy /></Button></div>
          <Button className="mt-4 w-full" asChild><a href={session.verificationUrl} target="_blank" rel="noopener noreferrer"><ExternalLink />打开官方授权页面</a></Button>
          <p className="mt-2 text-center font-mono text-[9px] text-[#a0aa95]">auth.openai.com/codex/device</p>
          <div role="status" className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-[#f7f8f4] px-4 py-3 text-[11px] text-[#8d987f]"><Loader2 size={13} className="animate-spin" />{session.status === 'exchanging' ? '正在验证并保存账号，请稍候…' : '等待你在官方页面完成授权，完成后会自动导入'}</div>
        </div> : <div className="mt-5 space-y-4">{failed && <div role="alert" className="rounded-lg border border-[#eedbd2] bg-[#fcf5ef] p-4 text-xs leading-6 text-[#b18165]">{session.error || '本次授权已结束，请重新开始'}</div>}<ol className="space-y-4 py-2 text-[11px] text-[#929d83]">{['获取一次性设备码，打开官方授权页面', '登录你要添加的账号，输入设备码并确认授权', '返回这里，系统自动验证并加入账号池'].map((text, i) => <li key={text} className="flex items-center gap-3"><span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-[#e0e6d6] text-[9px] text-[#98a387]">{i + 1}</span>{text}</li>)}</ol><Button className="w-full" disabled={busy} onClick={() => void begin()}>{busy ? <Loader2 className="animate-spin" /> : failed ? <RefreshCw /> : <KeyRound />}{busy ? '正在获取设备码…' : failed ? '重新获取设备码' : '获取设备码'}</Button></div>}
        {error && <p role="alert" className="mt-4 rounded-lg bg-[#fcf1ee] p-3 text-[11px] leading-5 text-[#b8786c]">{error}</p>}
        <div className="mt-6 flex items-start gap-2 border-t pt-4 text-[10px] leading-5 text-muted-foreground"><ShieldCheck size={13} className="mt-0.5 shrink-0" /><p>仅确认由你发起的授权，不要分享设备码。<br />若提示设备码登录未启用，请在 ChatGPT 安全设置或工作空间权限中开启。</p></div>
        {session && isPending(session) && <div className="mt-4 flex justify-center"><Button variant="ghost" size="sm" onClick={async () => { try { await cancelPending(); setError('') } catch { toast.error('取消失败，请重试') } }}><X />取消本次等待</Button></div>}
      </>}
    </div> : <form className="space-y-5" onSubmit={submit}>
      <label className="block"><span className="field-label">凭证来源</span><select className="select" value={source} onChange={e => setSource(e.target.value)}><option value="web">ChatGPT 网页登录</option><option value="codex">Codex 登录凭证</option></select></label>
      <label className="block"><span className="field-label">账号凭证</span><Textarea className="font-mono text-xs" rows={7} value={items} onChange={e => setItems(e.target.value)} placeholder={'{\n  "access_token": "…",\n  "refresh_token": "…",\n  "email": "you@example.com"\n}'} required /><p className="field-help">支持 JSON 对象、JSON 数组、Codex auth.json，或每行一个 access_token。最多 200 个。</p></label>
      <input ref={file} type="file" accept=".json,application/json" className="hidden" onChange={async e => { const selected = e.target.files?.[0]; if (selected) { if (selected.size > 1024 * 1024) return toast.error('文件不能超过 1 MB'); setItems(await selected.text()) } }} />
      <div className="flex items-center justify-between"><Button type="button" size="sm" variant="outline" onClick={() => file.current?.click()}><FileJson />选择 JSON 文件</Button><Button disabled={busy || !items.trim()} type="submit">{busy ? <Loader2 className="animate-spin" /> : <Upload />}导入并验证</Button></div>
      <p className="flex items-start gap-2 border-t pt-4 text-[10px] leading-5 text-muted-foreground"><ShieldCheck size={13} className="mt-0.5 shrink-0" />凭证加密保存，不会返回到页面。缺少 refresh_token 的账号无法自动续期。</p>
    </form>}
  </DialogContent></Dialog>
}
