import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, ChevronRight, Plus } from 'lucide-react'
import { Button } from '../ui/button'
import type { Snapshot } from '@/lib/client'
import { cn } from '@/lib/utils'
import { EmptyArt, Status } from './shared'
import { TaskTable } from './tasks'

const HOUR = 3600_000

function HourlyBars({ hourly, now }: { hourly: Snapshot['hourly']; now: number }) {
  const counts = new Map(hourly.map(item => [item.hour, item.count])), current = Math.floor(now / HOUR) * HOUR
  const buckets = Array.from({ length: 24 }, (_, i) => { const hour = current - (23 - i) * HOUR; return { hour, count: counts.get(hour) || 0 } })
  const max = Math.max(1, ...buckets.map(b => b.count))
  return <div className="absolute right-4 top-9 flex h-6 items-end gap-[1.5px]" aria-hidden>
    {buckets.map((b, i) => <span key={b.hour} title={`${new Date(b.hour).getHours()}:00 · ${b.count} 张`} className={cn('w-[2px] rounded-[1px] bg-accent', i === 23 ? 'opacity-100' : b.count ? 'opacity-40' : 'opacity-15')} style={{ height: `${Math.max(8, b.count / max * 100)}%` }} />)}
  </div>
}

export function Overview({ data, create, importAccount, openTask, createKey }: { data: Snapshot; create: () => void; importAccount: () => void; openTask: (id: string) => void; createKey: () => void }) {
  const ready = data.accounts.filter(a => a.status === 'ready')
  const pending = data.accounts.filter(a => ['pending', 'refreshing'].includes(a.status)).length, disabled = data.accounts.filter(a => a.status === 'disabled').length
  const queued = data.counts.queued || 0, generating = data.accounts.reduce((sum, a) => sum + a.inflight, 0), capacity = ready.reduce((sum, a) => sum + a.slots, 0)
  const delivered = data.delivered.success || 0, failed = data.delivered.error || 0, finished = delivered + failed, today = data.hourly.reduce((sum, item) => sum + item.count, 0)
  const setup = [
    { label: '授权添加第一个账号', done: ready.length > 0, action: importAccount },
    { label: '创建业务 API 密钥', done: data.keys.some(k => k.enabled), action: createKey },
    { label: '连接 OSS 图片存储', done: data.settings.storage === 'oss', to: '/settings' as const },
  ]
  const order = ['ready', 'refreshing', 'pending', 'limited', 'error', 'disabled']
  const accounts = [...data.accounts].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.inflight - a.inflight).slice(0, 8)
  return <div className="grid gap-3.5">
    <section className="kpis" aria-label="关键指标">
      <div className="kpi"><span className="kpi-label">可用账号</span><span className="kpi-value">{ready.length}<small>/ {data.accounts.length}</small></span>
        <span className={cn('kpi-sub', (pending || disabled) && 'text-warn-ink')}>{!data.accounts.length ? '还没有导入账号' : pending || disabled ? [pending && `${pending} 个待验证`, disabled && `${disabled} 个停用`].filter(Boolean).join(' · ') : '全部已验证'}</span></div>
      <div className="kpi"><span className="kpi-label">并发占用</span><span className="kpi-value">{generating}<small>/ {capacity}</small></span>
        <div className="meter" role="progressbar" aria-label="并发占用" aria-valuenow={generating} aria-valuemin={0} aria-valuemax={capacity}><span style={{ width: `${capacity ? Math.min(100, generating / capacity * 100) : 0}%` }} /></div></div>
      <div className="kpi"><span className="kpi-label">排队中</span><span className="kpi-value">{queued}<small>张</small></span><span className="kpi-sub">队列容量 {data.settings.queueLimit} 张</span></div>
      <div className="kpi"><span className="kpi-label">近 24 小时交付</span><span className="kpi-value">{today.toLocaleString()}<small>张</small></span><span className="kpi-sub">累计 {delivered.toLocaleString()} 张 · 不含演示</span><HourlyBars hourly={data.hourly} now={data.serverTime} /></div>
      <div className="kpi"><span className="kpi-label">成功率</span><span className="kpi-value">{finished ? (delivered / finished * 100).toFixed(1) : '—'}<small>{finished ? '%' : ''}</small></span>
        <span className={cn('kpi-sub', failed > 0 && 'text-bad-ink')}>{finished ? `${failed} 张失败 · 不含演示` : '完成首个真实任务后统计'}</span></div>
    </section>
    <div className="grid items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className="panel min-w-0 overflow-hidden">
        <div className="panel-heading"><h2 className="panel-title">最近任务</h2><Link to="/tasks" className="flex items-center gap-1 text-xs font-medium text-accent-text hover:underline">查看全部<ArrowRight size={12} /></Link></div>
        {data.tasks.length ? <TaskTable now={data.serverTime} tasks={data.tasks.slice(0, 8)} openTask={openTask} /> : <div className="subtle-grid px-6 py-12 text-center">
          <EmptyArt />
          <h3 className="text-[15px] font-medium">从第一组图片开始</h3>
          <p className="mx-auto mt-2 max-w-72 text-[13px] leading-6 text-muted-foreground">创建一个生图任务，或先运行本地演示，体验从排队到图片交付的完整流程。</p>
          <Button size="sm" className="mt-5" onClick={create}><Plus />创建第一个任务</Button>
        </div>}
      </section>
      <div className="grid gap-3.5">
        {!setup.every(item => item.done) && <section className="panel overflow-hidden">
          <div className="panel-heading"><h2 className="panel-title">开始使用</h2><span className="text-xs tabular-nums text-muted-foreground">{setup.filter(i => i.done).length} / {setup.length}</span></div>
          <div className="p-1.5">
            {setup.map((item, i) => {
              const inner = <>
                <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]', item.done ? 'border-ok/30 bg-ok-soft text-ok-ink' : 'border-border text-muted-foreground')}>{item.done ? <Check size={11} /> : i + 1}</span>
                <span className={cn('text-[13px]', item.done ? 'text-muted-foreground line-through' : 'text-soft')}>{item.label}</span>
                <ChevronRight size={13} className="ml-auto text-faint" />
              </>
              const className = 'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface'
              return item.to ? <Link key={item.label} to={item.to} className={className}>{inner}</Link> : <button key={item.label} onClick={item.action} className={className}>{inner}</button>
            })}
          </div>
        </section>}
        <section className="panel overflow-hidden">
          <div className="panel-heading"><h2 className="panel-title">账号负载</h2><Link to="/accounts" className="flex items-center gap-1 text-xs font-medium text-accent-text hover:underline">账号池<ArrowRight size={12} /></Link></div>
          {accounts.length ? accounts.map(account => <div key={account.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 border-b border-line-soft px-3.5 py-2.5 last:border-b-0">
            <p className="truncate text-[13px] font-semibold">{account.name}<span className="ml-1.5 font-normal text-muted-foreground">{account.plan === 'unknown' ? '' : account.plan}</span></p>
            <Status value={account.status} />
            <div className="meter !mt-0"><span style={{ width: `${Math.min(100, account.inflight / account.slots * 100)}%` }} /></div>
            <span className="font-mono text-xs tabular-nums text-soft">{account.inflight} / {account.slots}</span>
          </div>) : <p className="px-3.5 py-6 text-center text-[13px] text-muted-foreground">还没有账号</p>}
          {data.accounts.length > accounts.length && <Link to="/accounts" className="block border-t border-line-soft px-3.5 py-2 text-xs text-muted-foreground hover:text-foreground">还有 {data.accounts.length - accounts.length} 个账号</Link>}
        </section>
        <section className="panel overflow-hidden">
          <div className="panel-heading"><h2 className="panel-title">模型</h2><Link to="/keys" className="flex items-center gap-1 text-xs font-medium text-accent-text hover:underline">接入方式<ArrowRight size={12} /></Link></div>
          <div className="py-1">{data.models.map(model => <div key={model.id} className="flex items-center gap-2 px-3.5 py-1.5">
            <code className="truncate font-mono text-xs">{model.id}</code>
            <span className={cn('pill ml-auto', model.accounts ? 'green' : 'amber')}>{model.accounts ? `${model.accounts} 个账号` : '无可用账号'}</span>
          </div>)}</div>
        </section>
      </div>
    </div>
  </div>
}
