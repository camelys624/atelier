import { useEffect, useState } from 'react'
import { ChevronRight, Clock3, Image as ImageIcon, Loader2, Plus, Search, Sparkles, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input, Textarea } from '../ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { api, preferredModel, type Snapshot, type Task } from '@/lib/client'
import { cn } from '@/lib/utils'
import { formatDuration, taskTiming } from '@/lib/timing'
import { EmptyArt, Field, Status, Tabs, short, time } from './shared'

const columns = 'grid-cols-[minmax(200px,1fr)_88px_90px_110px_90px_16px]'
const filters = { all: () => true, active: (t: Task) => ['queued', 'running'].includes(t.status), success: (t: Task) => t.status === 'success', failed: (t: Task) => ['error', 'partial'].includes(t.status) || t.failed > 0 }
type Filter = keyof typeof filters

export function TaskTable({ tasks, openTask, now }: { tasks: Task[]; openTask: (id: string) => void; now: number }) {
  return <div className="overflow-x-auto"><div className="min-w-[700px]">
    <div className={cn('table-head', columns)}><span>任务 / 提示词</span><span>状态</span><span>图片</span><span title="从提交到结束，包含排队等待">总耗时</span><span>创建时间</span><span /></div>
    {tasks.map(task => {
      const timing = taskTiming(task, now), cover = task.images.find(i => i.url)?.url
      return <button key={task.id} onClick={() => openTask(task.id)} className={cn('task-row w-full text-left', columns)}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-[#f7f8f3] text-faint">{cover ? <img src={cover} className="size-full object-cover" alt="" loading="lazy" /> : <ImageIcon size={16} strokeWidth={1.3} />}</span>
          <div className="min-w-0">
            <p className="truncate text-[13px] text-foreground">{task.prompt}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{task.demo && <span className="mr-1.5 rounded bg-[#f9efda] px-1 text-[#85652f]">演示</span>}{short(task.id)} · {task.model === 'gpt-image-2' ? 'ChatGPT' : 'Codex'}</p>
          </div>
        </div>
        <span><Status value={task.status} /></span>
        <div className="text-[13px] tabular-nums">
          <p className="text-soft">{task.completed}<span className="text-muted-foreground"> / {task.n} 张</span></p>
          {task.failed > 0 && <p className="mt-1 text-xs text-[#a1443a]">{task.failed} 张失败</p>}
        </div>
        <div className="tabular-nums" title="总耗时包含排队；单图平均按已结束图片的本次处理时间计算">
          <p className="flex items-center gap-1 text-[13px] text-soft"><Clock3 size={12} className="text-faint" />{formatDuration(timing.total)}</p>
          {timing.average !== null && <p className="mt-1 text-xs text-muted-foreground">单图均 {formatDuration(timing.average)}</p>}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">{time(task.created)}</span>
        <ChevronRight size={14} className="text-faint" />
      </button>
    })}
  </div></div>
}

export function Tasks({ data, create, openTask }: { data: Snapshot; create: () => void; openTask: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all'), [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const filtered = data.tasks.filter(t => filters[filter](t) && `${t.prompt} ${t.id}`.toLowerCase().includes(q))
  const count = (key: Filter) => data.tasks.filter(filters[key]).length
  return <section className="panel overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-5 pt-4">
      <Tabs label="按状态筛选任务" value={filter} onChange={setFilter} items={[{ key: 'all', label: '全部', count: data.tasks.length }, { key: 'active', label: '进行中', count: count('active') }, { key: 'success', label: '已完成', count: count('success') }, { key: 'failed', label: '有失败', count: count('failed'), alert: true }]} />
      <div className="relative mb-3"><Search size={14} className="absolute left-3 top-2.5 text-faint" /><Input aria-label="搜索任务" placeholder="搜索提示词或任务 ID" className="h-9 w-60 pl-8 text-[13px]" value={query} onChange={e => setQuery(e.target.value)} /></div>
    </div>
    {filtered.length ? <TaskTable now={data.serverTime} tasks={filtered} openTask={openTask} /> : <div className="py-20 text-center">
      <EmptyArt />
      <h3 className="font-medium">{data.tasks.length ? '没有匹配的任务' : '第一组图片，从这里开始'}</h3>
      <p className="mt-2 text-[13px] text-muted-foreground">{data.tasks.length ? '换个关键词或状态试试。' : '支持一次生成 7 张图片，逐张查看进度与结果。'}</p>
      {data.tasks.length ? <Button className="mt-5" variant="outline" size="sm" onClick={() => { setQuery(''); setFilter('all') }}>清除筛选</Button> : <Button className="mt-5" variant="outline" size="sm" onClick={create}><Plus />新建任务</Button>}
    </div>}
    {data.tasks.length >= 100 && <p className="border-t px-5 py-3 text-xs text-muted-foreground">仅显示最近 100 个任务。</p>}
  </section>
}

export function CreateTask({ open, onOpenChange, data, complete }: { open: boolean; onOpenChange: (value: boolean) => void; data: Snapshot; complete: (task: Task) => Promise<void> }) {
  const anyReady = data.accounts.some(a => a.status === 'ready')
  const [prompt, setPrompt] = useState(''), [model, setModel] = useState(() => preferredModel(data.models)), [n, setN] = useState(7), [urls, setUrls] = useState(''), [demo, setDemo] = useState(!anyReady), [busy, setBusy] = useState(false)
  // Reopening the dialog moves off a model whose accounts are gone, so the default always has a usable account.
  useEffect(() => { if (!open) return; if (!anyReady) setDemo(true); if (!data.models.find(m => m.id === model)?.accounts) setModel(preferredModel(data.models)) }, [open])
  const selected = data.models.find(m => m.id === model), source = selected?.source || 'codex', usable = selected?.accounts || 0
  const ready = data.accounts.filter(a => a.source === source && a.status === 'ready')
  const free = ready.reduce((sum, a) => sum + Math.max(0, a.slots - a.inflight), 0)
  const refs = urls.split(/\s+/).filter(Boolean), tooMany = !demo && refs.length > 7
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !prompt.trim() || tooMany) return
    setBusy(true)
    try { const task = await api<Task>('/api/tasks', { prompt, model, n, image_urls: demo ? [] : refs, demo }); toast.success(demo ? '演示任务已进入队列' : '生图任务已提交'); setPrompt(''); setUrls(''); onOpenChange(false); await complete(task) } catch (error: any) { toast.error(error.message) } finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="!max-w-[640px]">
    <DialogTitle className="text-xl font-semibold tracking-tight">新建生图任务</DialogTitle>
    <DialogDescription className="mt-2 text-[13px] text-muted-foreground">每张图片单独排队和交付，可以在任务详情中查看进度。</DialogDescription>
    <form className="mt-7 space-y-5" onSubmit={submit}>
      <Field label="图片描述" help="按 Ctrl / ⌘ + Enter 快速提交">
        <Textarea autoFocus placeholder="例如：一组极简护肤品广告摄影，柔和自然光，鼠尾草绿背景，保持产品风格统一…" rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} required maxLength={12000} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="生成模型" help={demo ? undefined : usable ? `${usable} 个可用${source === 'codex' ? ' Codex ' : ' ChatGPT '}账号` : <span className="flex items-center gap-1 text-[#85652f]"><TriangleAlert size={12} />没有可用的{source === 'codex' ? ' Codex ' : ' ChatGPT '}账号</span>}>
          <select className="select" value={model} onChange={e => setModel(e.target.value)}>{data.models.map(m => <option key={m.id} value={m.id}>{m.source === 'codex' ? 'Codex' : 'ChatGPT'} · {m.name}{m.accounts ? '' : '（无可用账号）'}</option>)}</select>
        </Field>
        <Field label="图片数量"><select className="select" value={n} onChange={e => setN(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 7].map(value => <option value={value} key={value}>{value} 张{value === 7 ? ' · 一组' : ''}</option>)}</select></Field>
      </div>
      {!demo && <Field label="参考图地址（可选）" help={tooMany ? <span className="text-[#a1443a]">最多 7 张参考图，当前 {refs.length} 张</span> : '每行一个 HTTPS 图片地址，最多 7 张。域名需先在「服务设置」中允许。'}>
        <Textarea placeholder="https://your-bucket…/reference.png" value={urls} onChange={e => setUrls(e.target.value)} rows={2} aria-invalid={tooMany} className={cn(tooMany && 'border-[#d99a90]')} />
      </Field>}
      <label className={cn('flex cursor-pointer items-start gap-3 rounded-xl border p-4', demo ? 'border-[#e4d9c5] bg-[#fbf7ef]' : 'bg-surface')}>
        <input type="checkbox" className="mt-0.5 accent-[#9f865b]" checked={demo} onChange={e => setDemo(e.target.checked)} />
        <div><p className="text-[13px] font-medium text-[#6f5c3d]">本地演示模式</p><p className="mt-1.5 text-xs leading-5 text-[#7d6c50]">生成固定的示例预览，用于测试队列和结果查看。不调用 ChatGPT，不消耗账号额度，也不验证 OSS 链路。</p></div>
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
        <span className="text-xs text-muted-foreground">{n} 张图片{!demo && usable > 0 && ` · 当前空闲并发 ${free}，${free >= n ? '可全部立即开始' : free ? `${free} 张立即开始，其余排队` : '全部排队等待'}`}</span>
        <Button disabled={busy || !prompt.trim() || tooMany} type="submit">{busy ? <Loader2 className="animate-spin" /> : <Sparkles />}{demo ? '创建演示任务' : '提交生图任务'}</Button>
      </div>
    </form>
  </DialogContent></Dialog>
}
