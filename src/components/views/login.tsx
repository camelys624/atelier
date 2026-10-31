import { useState } from 'react'
import { ArrowRight, Eye, EyeOff, Layers2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { api } from '@/lib/client'
import { Brand, Field } from './shared'

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [key, setKey] = useState(''), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true)
    try { await api('/api/auth/login', { key }); onSuccess() } catch (error: any) { toast.error(error.message) } finally { setBusy(false) }
  }
  return <div className="grid min-h-screen lg:grid-cols-[1fr_1fr]">
    <div className="relative hidden overflow-hidden bg-[#485340] p-12 text-[#eef0e7] lg:flex lg:flex-col">
      <div className="wordmark !px-0"><span className="brand-icon !bg-[#d7bd9c] !text-[#485340]">a</span>atelier.</div>
      <div className="login-orbit" /><div className="login-orbit !size-[650px]" />
      <div className="relative m-auto">
        <div className="mx-auto mb-9 flex size-24 items-center justify-center rounded-3xl border border-[#d9dec744] bg-[#c7d2aa14] shadow-xl"><Layers2 size={40} strokeWidth={1} /></div>
        <h1 className="text-center text-[38px] font-light tracking-[-1.5px]">从一个想法，<br />到每一张好图片。</h1>
        <p className="mt-6 text-center text-sm leading-7 text-[#d3dac7]">账号池、任务与图片交付。<br />一个简单、属于你的生图服务。</p>
      </div>
    </div>
    <div className="flex items-center justify-center px-8 py-20">
      <form onSubmit={submit} className="w-full max-w-[350px]">
        <div className="mb-12 lg:hidden"><Brand /></div>
        <h2 className="text-3xl font-semibold tracking-tight">欢迎回来</h2>
        <p className="mb-9 mt-3 text-sm text-muted-foreground">使用管理员密钥登录后台。</p>
        <Field label="管理员密钥">
          <div className="relative">
            <Input name="key" autoComplete="current-password" type={visible ? 'text' : 'password'} placeholder="请输入 ADMIN_KEY" className="pr-10" value={key} onChange={e => setKey(e.target.value)} required autoFocus />
            <button type="button" className="row-action absolute right-1.5 top-1/2 -translate-y-1/2" aria-label={visible ? '隐藏密钥' : '显示密钥'} onClick={() => setVisible(v => !v)}>{visible ? <EyeOff size={15} /> : <Eye size={15} />}</button>
          </div>
        </Field>
        <Button disabled={busy || !key} className="mt-5 w-full" type="submit">{busy ? <><Loader2 className="animate-spin" />正在登录…</> : <>登录<ArrowRight /></>}</Button>
        <p className="mt-5 text-xs leading-6 text-muted-foreground">密钥为服务器 <code className="rounded bg-muted px-1 py-0.5">.env</code> 中的 ADMIN_KEY。<br />账号凭证与存储密钥仅保存在服务端。</p>
      </form>
    </div>
  </div>
}
