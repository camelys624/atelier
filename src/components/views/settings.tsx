import { useEffect, useRef, useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { Check, Cloud, Loader2, RefreshCw, Server, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input, Textarea } from '../ui/input'
import { api, type Settings } from '@/lib/client'
import { cn } from '@/lib/utils'
import { Field } from './shared'

const parseHosts = (text: string) => text.split(/\s+/).map(v => v.trim().toLowerCase()).filter(Boolean)
// Comparable form of the settings; the secret is write-only, so any typed value counts as a change.
const fingerprint = (s: Settings, hosts: string[]) => JSON.stringify({ ...s, allowedImageHosts: hosts, oss: { ...s.oss, accessKeySecret: '', hasCredentials: null } }) + s.oss.accessKeySecret

export function SettingsForm({ initial, reload }: { initial: Settings; reload: () => Promise<void> }) {
  const [form, setForm] = useState<Settings>(() => structuredClone(initial)), [hosts, setHosts] = useState(initial.allowedImageHosts.join('\n')), [busy, setBusy] = useState(false), [testing, setTesting] = useState(false)
  const dirty = fingerprint(form, parseHosts(hosts)) !== fingerprint(initial, initial.allowedImageHosts)
  const resync = useRef(false), dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  function reset() { setForm(structuredClone(initial)); setHosts(initial.allowedImageHosts.join('\n')) }
  useEffect(() => { if (resync.current || !dirtyRef.current) { resync.current = false; reset() } }, [initial])
  useBlocker({ shouldBlockFn: () => dirty && !window.confirm('设置还没有保存，确定离开吗？'), enableBeforeUnload: () => dirty })
  const field = (key: keyof Settings, value: unknown) => setForm(old => ({ ...old, [key]: value }))
  const oss = (key: string, value: unknown) => setForm(old => ({ ...old, oss: { ...old.oss, [key]: value } }))
  async function persist() {
    setBusy(true)
    try { await api('/api/settings', { ...form, allowedImageHosts: parseHosts(hosts) }); resync.current = true; await reload(); toast.success('设置已保存'); return true } catch (error: any) { toast.error(error.message); return false } finally { setBusy(false) }
  }
  async function test() {
    if (dirty && !await persist()) return
    setTesting(true)
    try { await api('/api/settings/test-oss', {}); toast.success('OSS 写入、读取、删除测试成功') } catch (error: any) { toast.error(error.message) } finally { setTesting(false) }
  }
  const usingOss = form.storage === 'oss'
  return <form onSubmit={event => { event.preventDefault(); void persist() }} className="space-y-6">
    <section className="panel">
      <div className="panel-heading"><div className="flex items-center gap-3"><SlidersHorizontal size={17} className="text-faint" /><h2 className="panel-title">任务调度</h2></div><span className="text-xs text-muted-foreground">单服务实例</span></div>
      <div className="grid gap-6 p-6 md:grid-cols-2 xl:grid-cols-3">
        <Field label="图片总并发" help="所有任务合计同时处理的图片数，1～30。"><Input type="number" min={1} max={30} value={form.globalConcurrency} onChange={e => field('globalConcurrency', Number(e.target.value))} required /></Field>
        <Field label="单任务图片并发" help="限制单个 7 张任务的占用，让其他任务也能被处理；不能超过总并发。"><Input type="number" min={1} max={Math.min(7, form.globalConcurrency || 7)} value={form.taskConcurrency} onChange={e => field('taskConcurrency', Number(e.target.value))} required /></Field>
        <Field label="队列容量（张）" help="包含排队和处理中的图片；队列满后拒绝新增。"><Input type="number" min={10} max={2000} value={form.queueLimit} onChange={e => field('queueLimit', Number(e.target.value))} required /></Field>
        <Field label="单图超时（秒）" help="60～1800 秒。"><Input type="number" min={60} max={1800} value={form.jobTimeoutSeconds} onChange={e => field('jobTimeoutSeconds', Number(e.target.value))} required /></Field>
        <Field label="账号检查间隔（分钟）" help="1～60 分钟。"><Input type="number" min={1} max={60} value={form.refreshMinutes} onChange={e => field('refreshMinutes', Number(e.target.value))} required /></Field>
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><div className="flex items-center gap-3"><Cloud size={17} className="text-faint" /><h2 className="panel-title">图片存储</h2></div><span className="pill">{initial.storage === 'oss' ? '当前：阿里云 OSS' : '当前：本地存储'}</span></div>
      <div className="p-6">
        <div role="radiogroup" aria-label="图片存储方式" className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
          {[{ key: 'local', title: '本地存储', text: '先验证服务，图片暂存在服务器', icon: Server }, { key: 'oss', title: '阿里云 OSS', text: '上传存储，返回图片访问地址', icon: Cloud }].map(item => {
            const checked = form.storage === item.key
            return <button type="button" role="radio" aria-checked={checked} key={item.key} onClick={() => field('storage', item.key)} className={cn('rounded-xl border p-4 text-left transition-colors', checked ? 'border-[#a8b393] bg-[#f6f8f1]' : 'hover:bg-muted')}>
              <div className="mb-2 flex items-center justify-between"><item.icon size={18} className="text-[#7f8c6c]" /><span className={cn('flex size-4 items-center justify-center rounded-full border', checked && 'border-[#7d8e62] bg-[#7d8e62]')}>{checked && <Check size={10} className="text-white" />}</span></div>
              <p className="text-[13px] font-medium">{item.title}</p><p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.text}</p>
            </button>
          })}
        </div>
        {usingOss ? <>
          <div className="mt-6 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <Field label="Region" help="例如 oss-ap-southeast-1"><Input placeholder="oss-ap-southeast-1" value={form.oss.region} onChange={e => oss('region', e.target.value)} required /></Field>
            <Field label="Bucket 名称"><Input placeholder="your-image-bucket" value={form.oss.bucket} onChange={e => oss('bucket', e.target.value)} required /></Field>
            <Field label="Endpoint（可选）" help="同地域服务器可填写 HTTPS 内网 Endpoint。"><Input placeholder="https://oss-…-internal.aliyuncs.com" value={form.oss.endpoint} onChange={e => oss('endpoint', e.target.value)} /></Field>
            <Field label="AccessKey ID"><Input autoComplete="off" value={form.oss.accessKeyId} onChange={e => oss('accessKeyId', e.target.value)} placeholder="AccessKey ID" required /></Field>
            <Field label="AccessKey Secret" help={form.oss.hasCredentials ? '已保存凭证，留空保留原密钥。' : '保存后加密存储，页面不返回完整密钥。'}><Input autoComplete="new-password" type="password" value={form.oss.accessKeySecret} onChange={e => oss('accessKeySecret', e.target.value)} placeholder={form.oss.hasCredentials ? '已保存，留空保持不变' : 'AccessKey Secret'} required={!form.oss.hasCredentials} /></Field>
            <Field label="文件目录前缀"><Input value={form.oss.prefix} onChange={e => oss('prefix', e.target.value)} placeholder="atelier" /></Field>
            <Field label="图片公开域名（可选）" help="不填则返回私有对象的临时签名链接；查询任务可刷新链接。" className="md:col-span-2"><Input placeholder="https://images.example.com" value={form.publicBaseUrl} onChange={e => field('publicBaseUrl', e.target.value)} /></Field>
            <Field label="签名链接有效期（秒）"><Input type="number" min={60} max={86400} value={form.oss.urlExpiry} onChange={e => oss('urlExpiry', Number(e.target.value))} /></Field>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t pt-5">
            <Button type="button" size="sm" variant="outline" disabled={testing || busy} onClick={() => void test()}>{testing || busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}{dirty ? '保存并测试连接' : '测试连接'}</Button>
            <p className="text-xs text-muted-foreground">实际执行一次写入、读取和删除。演示任务始终使用本地存储。</p>
          </div>
        </> : <p className="mt-5 text-[13px] text-muted-foreground">图片保存在服务器的 data 目录，适合先验证服务。正式接入建议切换到 OSS。</p>}
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><div className="flex items-center gap-3"><ShieldCheck size={17} className="text-faint" /><h2 className="panel-title">参考图地址</h2></div></div>
      <div className="max-w-3xl p-6"><Field label="允许读取的图片域名" help="每行一个完整域名，仅允许 HTTPS 图片地址。填写你们的 OSS 或图片 CDN 域名。"><Textarea placeholder={'your-bucket.oss-ap-southeast-1.aliyuncs.com\nimages.example.com'} value={hosts} onChange={e => setHosts(e.target.value)} rows={3} /></Field></div>
    </section>
    <div className={cn('sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl', dirty && 'border border-[#e4d9c5] bg-[#fffdf8]/95 px-4 py-3 shadow-lg backdrop-blur')}>
      {dirty && <span className="mr-auto flex items-center gap-2 text-[13px] text-[#6f5c3d]"><span className="size-2 rounded-full bg-[#c9963f]" />有未保存的修改</span>}
      {dirty && <Button type="button" variant="ghost" disabled={busy} onClick={reset}>放弃修改</Button>}
      <Button disabled={busy || !dirty} type="submit">{busy ? <Loader2 className="animate-spin" /> : <Check />}保存设置</Button>
    </div>
  </form>
}
