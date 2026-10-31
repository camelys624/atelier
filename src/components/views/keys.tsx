import { useState } from 'react'
import { Copy, KeyRound, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { api, preferredModel, type ApiKey, type Snapshot } from '@/lib/client'
import { cn } from '@/lib/utils'
import { ConfirmDialog, Field, Status, copy, time, type Action } from './shared'

export function Keys({ data, add, action }: { data: Snapshot; add: () => void; action: Action }) {
  const [format, setFormat] = useState<'curl' | 'js'>('curl'), [revoke, setRevoke] = useState<ApiKey | null>(null)
  const model = preferredModel(data.models), missingWeb = data.models.some(m => m.source === 'web' && !m.accounts)
  const example = format === 'curl' ? `curl ${data.baseUrl}/v1/image-tasks \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: your-order-001" \\\n  -d '{"model":"${model}","prompt":"极简护肤品广告摄影","n":7}'` : `const task = await fetch('${data.baseUrl}/v1/image-tasks', {\n  method: 'POST',\n  headers: { 'Authorization': 'Bearer YOUR_API_KEY',\n    'Content-Type': 'application/json', 'Idempotency-Key': 'your-order-001' },\n  body: JSON.stringify({ model: '${model}', prompt: '极简护肤品广告摄影', n: 7 })\n}).then(res => res.json())`
  return <div className="space-y-6">
    <section className="panel overflow-hidden">
      <div className="panel-heading"><h2 className="panel-title">业务密钥</h2><span className="text-xs text-muted-foreground">完整密钥只在创建时显示一次</span></div>
      {data.keys.length ? <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-[13px]">
        <thead className="bg-surface text-xs text-muted-foreground"><tr>{['名称', '密钥', '状态', '最近使用', ''].map((label, i) => <th key={i} className="px-6 py-3 font-normal">{label}</th>)}</tr></thead>
        <tbody>{data.keys.map(key => <tr key={key.id} className={cn('border-t', !key.enabled && 'text-muted-foreground')}>
          <td className="px-6 py-4 font-medium">{key.name}</td>
          <td className="px-6 py-4 font-mono text-xs text-muted-foreground">{key.prefix}••••••••</td>
          <td className="px-6 py-4"><Status value={key.enabled ? 'ready' : 'revoked'} /></td>
          <td className="px-6 py-4 text-xs tabular-nums text-muted-foreground">{key.last_used ? time(key.last_used) : '从未使用'}</td>
          <td className="px-6 py-4 text-right">{key.enabled ? <Button variant="ghost" size="sm" className="hover:!text-red-600" onClick={() => setRevoke(key)}>撤销</Button> : null}</td>
        </tr>)}</tbody>
      </table></div> : <div className="flex flex-wrap items-center justify-between gap-5 p-7">
        <div className="flex items-center gap-4"><span className="flex size-12 items-center justify-center rounded-xl bg-[#f3f5ed] text-[#8a977a]"><KeyRound size={22} strokeWidth={1.4} /></span><div><h3 className="text-sm font-medium">为你的业务创建第一把密钥</h3><p className="mt-2 text-[13px] text-muted-foreground">业务密钥可以提交和查询自己的任务，不能管理账号。</p></div></div>
        <Button size="sm" onClick={add}><Plus />创建密钥</Button>
      </div>}
    </section>
    <section className="panel overflow-hidden">
      <div className="panel-heading"><h2 className="panel-title">模型列表</h2><span className="text-xs text-muted-foreground">请求中的 model 参数；每个模型只能由对应来源的账号生成</span></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-[13px]">
        <thead className="bg-surface text-xs text-muted-foreground"><tr>{['模型 ID', '名称', '所需账号', '状态'].map(label => <th key={label} className="px-6 py-3 font-normal">{label}</th>)}</tr></thead>
        <tbody>{data.models.map(item => <tr key={item.id} className="border-t">
          <td className="px-6 py-4"><div className="flex items-center gap-1"><code className="font-mono text-[13px]">{item.id}</code><button className="row-action" aria-label={`复制 ${item.id}`} onClick={() => void copy(item.id, '模型 ID 已复制')}><Copy size={13} /></button></div></td>
          <td className="px-6 py-4"><p>{item.name}</p><p className="mt-1 text-xs text-muted-foreground">{item.description}</p></td>
          <td className="px-6 py-4"><span className="pill">{item.source === 'codex' ? 'Codex' : 'ChatGPT 网页'}</span></td>
          <td className="px-6 py-4">{item.accounts ? <span className="pill green"><span className="size-1.5 rounded-full bg-current" />{item.accounts} 个可用账号</span> : <span className="pill amber"><span className="size-1.5 rounded-full bg-current" />无可用账号</span>}</td>
        </tr>)}</tbody>
      </table></div>
      {missingWeb && <p className="border-t px-6 py-3 text-xs leading-6 text-muted-foreground">「授权登录」添加的是 Codex 账号，可使用 codex-gpt-image-2 和 gpt-image-2.5-sunburst；使用 gpt-image-2 需要在「添加账号 → 手动导入」中添加 ChatGPT 网页账号。</p>}
    </section>
    <section className="panel overflow-hidden">
      <div className="panel-heading"><h2 className="panel-title">快速接入：提交任务，获取图片地址</h2><span className="pill">JSON API</span></div>
      <div className="grid gap-0 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0 p-6">
          <div className="mb-3 flex items-center justify-between">
            <div role="tablist" aria-label="示例语言" className="flex rounded-md bg-[#f0f2ea] p-1">{(['curl', 'js'] as const).map(value => <button key={value} role="tab" aria-selected={value === format} className={cn('rounded px-3 py-1 text-xs', value === format ? 'bg-white font-medium shadow-xs' : 'text-muted-foreground hover:text-foreground')} onClick={() => setFormat(value)}>{value === 'js' ? 'JavaScript' : 'cURL'}</button>)}</div>
            <Button size="sm" variant="ghost" onClick={() => void copy(example, '示例已复制')}><Copy />复制</Button>
          </div>
          <pre className="code overflow-x-auto rounded-xl bg-[#292f26] p-5 text-[#d2ddc5]">{example}</pre>
          <p className="mt-4 text-[13px] leading-7 text-muted-foreground">响应返回任务 ID。查询 <code className="rounded bg-muted px-1.5 py-0.5 text-xs">GET /v1/image-tasks/&#123;id&#125;</code>，读取每张图片的状态与 URL。重复请求使用相同的幂等标识，避免重复生成。</p>
        </div>
        <div className="space-y-5 border-t bg-surface p-6 lg:border-l lg:border-t-0">
          <div><p className="field-label">接口地址</p><div className="flex items-start gap-1"><code className="break-all text-xs text-soft">{data.baseUrl}/v1</code><button className="row-action -mt-1.5 shrink-0" aria-label="复制接口地址" onClick={() => void copy(`${data.baseUrl}/v1`, '接口地址已复制')}><Copy size={13} /></button></div></div>
          <div><p className="field-label">模型列表</p><code className="text-xs text-muted-foreground">GET /models</code><p className="field-help">返回模型 ID，available 表示当前是否有可用账号。</p></div>
          <div><p className="field-label">文生图</p><code className="text-xs text-muted-foreground">POST /images/generations</code></div>
          <div><p className="field-label">带参考图生成</p><code className="text-xs text-muted-foreground">POST /images/edits</code><p className="field-help">支持 image 文件上传，或 JSON 中传 image / image_urls 地址数组。OSS 域名需先在设置中允许。</p></div>
          <div><p className="field-label">响应格式</p><p className="text-xs leading-6 text-muted-foreground">编辑接口默认返回 Base64，可指定 response_format=url。异步任务返回 URL。同步接口最多等待 180 秒；超时后请查询 task_id，任务不会自动取消。</p></div>
        </div>
      </div>
    </section>
    <ConfirmDialog open={!!revoke} onOpenChange={open => !open && setRevoke(null)} title="撤销这个密钥？" description={<>使用「{revoke?.name}」（{revoke?.prefix}…）的业务将立即无法提交和查询任务。撤销后无法恢复，只能重新创建。</>} confirm="撤销密钥" onConfirm={async () => { if (await action(`/api/keys/${revoke!.id}`, undefined, 'DELETE', '密钥已撤销')) setRevoke(null) }} />
  </div>
}

export function CreateKey({ open, onOpenChange, complete }: { open: boolean; onOpenChange: (value: boolean) => void; complete: () => Promise<void> }) {
  const [name, setName] = useState(''), [key, setKey] = useState(''), [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); try { const result = await api('/api/keys', { name }); setKey(result.key); await complete() } catch (error: any) { toast.error(error.message) } finally { setBusy(false) } }
  function change(value: boolean) { onOpenChange(value); if (!value) { setKey(''); setName('') } }
  return <Dialog open={open} onOpenChange={change}><DialogContent>
    <DialogTitle className="text-xl font-semibold">{key ? '密钥已创建' : '创建 API 密钥'}</DialogTitle>
    <DialogDescription className="mt-2 text-[13px] leading-6 text-muted-foreground">{key ? '请立即复制并妥善保存，关闭后无法再次查看完整密钥。' : '为不同业务创建独立密钥，便于单独撤销访问。'}</DialogDescription>
    {key ? <div className="mt-6">
      <div className="break-all rounded-lg border border-[#dee5d1] bg-[#f6f8f0] p-4 font-mono text-[13px] leading-6 select-all">{key}</div>
      <div className="mt-4 flex gap-2"><Button className="flex-1" onClick={() => void copy(key, '密钥已复制')}><Copy />复制密钥</Button><Button variant="outline" onClick={() => change(false)}>我已保存</Button></div>
    </div> : <form className="mt-6 space-y-5" onSubmit={submit}>
      <Field label="密钥名称"><Input autoFocus placeholder="例如：电商生图业务" value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></Field>
      <div className="rounded-lg bg-muted p-4 text-[13px] leading-6 text-muted-foreground">权限：提交生图任务、查询自己的任务结果。<br />无法查看账号凭证或修改服务设置。</div>
      <div className="flex justify-end"><Button disabled={busy || !name.trim()} type="submit">{busy ? <Loader2 className="animate-spin" /> : <KeyRound />}创建密钥</Button></div>
    </form>}
  </DialogContent></Dialog>
}
