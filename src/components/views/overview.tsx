import { Link } from '@tanstack/react-router'
import { ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, Cloud, Code2, Image as ImageIcon, Layers2, Plus, Users, Workflow } from 'lucide-react'
import { Button } from '../ui/button'
import type { Snapshot } from '@/lib/client'
import { cn } from '@/lib/utils'
import { EmptyArt } from './shared'
import { TaskTable } from './tasks'

const HOUR = 3600_000

function HourlyBars({ hourly, now }: { hourly: Snapshot['hourly']; now: number }) {
  const counts = new Map(hourly.map(item => [item.hour, item.count])), current = Math.floor(now / HOUR) * HOUR
  const buckets = Array.from({ length: 24 }, (_, i) => { const hour = current - (23 - i) * HOUR; return { hour, count: counts.get(hour) || 0 } })
  const max = Math.max(1, ...buckets.map(b => b.count))
  return <div className="ml-auto flex h-8 items-end gap-[2px] self-end" aria-hidden>
    {buckets.map(b => <span key={b.hour} title={`${new Date(b.hour).getHours()}:00 · ${b.count} 张`} className={cn('w-[3px] rounded-sm', b.count ? 'bg-[#8fa0b0]' : 'bg-[#e6e9e2]')} style={{ height: `${Math.max(8, b.count / max * 100)}%` }} />)}
  </div>
}

export function Overview({ data, online, create, importAccount, openTask, createKey }: { data: Snapshot; online: boolean; create: () => void; importAccount: () => void; openTask: (id: string) => void; createKey: () => void }) {
  const ready = data.accounts.filter(a => a.status === 'ready').length, pending = data.accounts.filter(a => a.status === 'pending').length
  const active = (data.counts.generating || 0) + (data.counts.uploading || 0), queued = data.counts.queued || 0
  const capacity = data.accounts.filter(a => a.status === 'ready').reduce((sum, a) => sum + a.slots, 0), generating = data.accounts.reduce((sum, a) => sum + a.inflight, 0)
  const delivered = data.delivered.success || 0, finished = delivered + (data.delivered.error || 0), today = data.hourly.reduce((sum, item) => sum + item.count, 0)
  const cards = [
    { title: '可用账号', value: ready, suffix: `/ ${data.accounts.length}`, icon: Users, foot: data.accounts.length ? pending ? `${pending} 个待验证` : '全部已验证' : '还没有导入账号', accent: '#7e8c6b' },
    { title: '正在处理', value: active, suffix: '张', icon: Workflow, foot: queued ? `${queued} 张排队中` : '队列为空', accent: '#bd916a' },
    { title: '近 24 小时交付', value: today, suffix: '张', icon: ImageIcon, foot: `累计 ${delivered} 张 · 不含演示`, accent: '#7f929e', chart: true },
    { title: '生成成功率', value: finished ? Math.round(delivered / finished * 100) : '—', suffix: finished ? '%' : '', icon: CheckCheck, foot: finished ? `基于 ${finished} 张已结束图片` : '完成首个真实任务后统计', accent: '#9c8c9c' },
  ]
  const setup = [
    { label: '授权添加第一个账号', done: ready > 0, action: importAccount },
    { label: '创建业务 API 密钥', done: data.keys.some(k => k.enabled), action: createKey },
    { label: '连接 OSS 图片存储', done: data.settings.storage === 'oss', to: '/settings' as const },
  ]
  const setupDone = setup.every(item => item.done)
  return <>
    <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(card => <section key={card.title} className="panel metric">
        <div className="mb-3 flex items-center justify-between"><span className="text-[13px] text-soft">{card.title}</span><card.icon size={16} strokeWidth={1.5} className="text-faint" /></div>
        <div className="flex items-baseline gap-2"><span className="metric-number">{card.value}</span><span className="text-xs text-muted-foreground">{card.suffix}</span>{card.chart && <HourlyBars hourly={data.hourly} now={data.serverTime} />}</div>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-1.5 rounded-full" style={{ background: card.accent }} />{card.foot}</div>
      </section>)}
    </div>
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-6">
        <section className="panel overflow-hidden">
          <div className="panel-heading">
            <div className="flex items-center gap-2.5"><h2 className="panel-title">最近任务</h2>{data.tasks.length > 0 && <span className="tab-count">{data.tasks.length}</span>}</div>
            <Link to="/tasks" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">查看全部<ArrowUpRight size={13} /></Link>
          </div>
          {data.tasks.length ? <TaskTable now={data.serverTime} tasks={data.tasks.slice(0, 5)} openTask={openTask} /> : <div className="subtle-grid px-6 py-14 text-center">
            <EmptyArt />
            <h3 className="text-[15px] font-medium">从第一组图片开始</h3>
            <p className="mx-auto mt-2 max-w-72 text-[13px] leading-6 text-muted-foreground">创建一个生图任务，或先运行本地演示，体验从排队到图片交付的完整流程。</p>
            <Button size="sm" variant="outline" className="mt-5 !bg-white" onClick={create}><Plus />创建第一个任务</Button>
          </div>}
        </section>
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between gap-4 p-6">
            <div><h2 className="panel-title">把生图能力接入你的业务</h2><p className="mt-2 text-[13px] leading-6 text-muted-foreground">提交提示词和参考图地址，获取任务进度与图片地址。</p></div>
            <span className="hidden size-12 shrink-0 items-center justify-center rounded-xl border border-[#e9e7dd] bg-[#f8f7f1] text-[#a88a6b] sm:flex"><Code2 size={23} strokeWidth={1.2} /></span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t bg-surface px-6 py-4">
            <code className="code overflow-auto whitespace-pre text-soft"><span className="text-[#a0643f]">POST</span> /v1/image-tasks{'\n'}<span className="text-muted-foreground">{'{ "prompt": "你的图片描述", "n": 7 }'}</span></code>
            <Button size="sm" variant="ghost" asChild><Link to="/keys">查看接入方式<ArrowRight /></Link></Button>
          </div>
        </section>
      </div>
      <aside className="space-y-5">
        <section className="panel">
          <div className="panel-heading">
            <h2 className="panel-title">服务状态</h2>
            {online ? <span className="pill green"><span className="size-1.5 rounded-full bg-current" />运行中</span> : <span className="pill red"><span className="size-1.5 rounded-full bg-current" />连接断开</span>}
          </div>
          <div className="space-y-4 p-[22px] text-[13px]">
            <div className="flex items-center"><Cloud size={15} className="mr-2.5 text-faint" /><span className="text-muted-foreground">图片存储</span><Link to="/settings" className="ml-auto text-soft hover:underline">{data.settings.storage === 'oss' ? '阿里云 OSS' : '本地存储'}</Link></div>
            <div className="flex items-center"><Layers2 size={15} className="mr-2.5 text-faint" /><span className="text-muted-foreground">队列占用</span><span className="ml-auto tabular-nums text-soft">{queued + active} <span className="text-muted-foreground">/ {data.settings.queueLimit}</span></span></div>
            <div className="border-t pt-4">
              <div className="flex justify-between"><span className="text-muted-foreground">账号并发占用</span><span className="tabular-nums text-soft">{generating} <span className="text-muted-foreground">/ {capacity}</span></span></div>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[#eef0e8]" role="progressbar" aria-label="账号并发占用" aria-valuenow={generating} aria-valuemin={0} aria-valuemax={capacity}><div className="h-full rounded-full bg-[#91a078] transition-all" style={{ width: `${capacity ? Math.min(100, generating / capacity * 100) : 0}%` }} /></div>
              <p className="mt-2.5 text-xs text-muted-foreground">总容量为可用账号的并发上限之和，超出后自动排队</p>
            </div>
          </div>
        </section>
        {!setupDone && <section className="panel">
          <div className="panel-heading"><h2 className="panel-title">开始使用</h2><span className="text-xs tabular-nums text-muted-foreground">{setup.filter(i => i.done).length} / {setup.length}</span></div>
          <div className="p-2.5">
            {setup.map((item, i) => {
              const inner = <>
                <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]', item.done ? 'border-[#d9e2cd] bg-[#edf3e6] text-[#6c8550]' : 'border-[#dfe2d6] text-muted-foreground')}>{item.done ? <Check size={11} /> : i + 1}</span>
                <span className={cn('text-[13px]', item.done ? 'text-muted-foreground line-through' : 'text-soft')}>{item.label}</span>
                <ChevronRight size={13} className="ml-auto text-faint" />
              </>
              const className = 'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-[#f7f8f3]'
              return item.to ? <Link key={item.label} to={item.to} className={className}>{inner}</Link> : <button key={item.label} onClick={item.action} className={className}>{inner}</button>
            })}
          </div>
        </section>}
      </aside>
    </div>
  </>
}
