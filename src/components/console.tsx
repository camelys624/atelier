import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Code2, KeyRound, Layers2, LayoutDashboard, Loader2, LogOut, Plus, Settings2, Users, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { api, type Snapshot } from '@/lib/client'
import { cn } from '@/lib/utils'
import { AccountImportDialog as ImportAccounts } from './account-import'
import { Brand, type Action } from './views/shared'
import { Login } from './views/login'
import { Overview } from './views/overview'
import { CreateTask, Tasks } from './views/tasks'
import { TaskDetail } from './views/task-detail'
import { Accounts } from './views/accounts'
import { CreateKey, Keys } from './views/keys'
import { SettingsForm } from './views/settings'

type View = 'overview' | 'accounts' | 'tasks' | 'keys' | 'settings'
const views = { overview: { title: '运行概览', path: '/', icon: LayoutDashboard }, tasks: { title: '任务队列', path: '/tasks', icon: Layers2 }, accounts: { title: '账号池', path: '/accounts', icon: Users }, keys: { title: 'API 密钥', path: '/keys', icon: KeyRound }, settings: { title: '服务设置', path: '/settings', icon: Settings2 } } as const

export function Console({ view }: { view: View }) {
  const [data, setData] = useState<Snapshot | null>(null), [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [createOpen, setCreateOpen] = useState(false), [importOpen, setImportOpen] = useState(false), [keyOpen, setKeyOpen] = useState(false)
  const [networkError, setNetworkError] = useState(false)
  const mounted = useRef(true), loading = useRef(false)
  const navigate = useNavigate(), detail = (useSearch({ strict: false }) as { task?: string }).task
  async function load() {
    if (loading.current) return
    loading.current = true
    try {
      const value = await api<Snapshot>('/api/bootstrap')
      if (mounted.current) { setData(value); setAuthenticated(true); setNetworkError(false) }
    } catch (error: any) {
      if (mounted.current) { if (error.status === 401) setAuthenticated(false); else setNetworkError(true) }
    } finally { loading.current = false }
  }
  useEffect(() => { mounted.current = true; void load(); const timer = setInterval(() => { if (!document.hidden) void load() }, 3000); return () => { mounted.current = false; clearInterval(timer) } }, [])
  useEffect(() => { document.title = `${views[view].title} · Atelier` }, [view])
  const action: Action = async (path, value, method, message = '操作已完成') => {
    try { await api(path, value, method); toast.success(message); await load(); return true } catch (error: any) { toast.error(error.message); return false }
  }
  const taskPath = view === 'tasks' ? '/tasks' : '/'
  const openTask = (id: string) => void navigate({ to: taskPath, search: { task: id } })
  const closeTask = () => void navigate({ to: taskPath, search: {} })
  async function logout() {
    try { await api('/api/auth/logout', {}); setAuthenticated(false); setData(null) } catch (error: any) { toast.error(error.message) }
  }
  if (authenticated === false) return <Login onSuccess={() => void load()} />
  if (!data) return <div className="grid min-h-screen place-items-center"><div className="text-center"><Brand /><p className="mt-8 flex items-center justify-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" />{networkError ? '无法连接服务，正在重试…' : '正在加载…'}</p></div></div>
  const meta = views[view], active = (data.counts.generating || 0) + (data.counts.uploading || 0), queued = data.counts.queued || 0
  return <div className="shell">
    <aside className="sidebar">
      <Brand />
      <nav aria-label="主导航">{(Object.keys(views) as View[]).map(key => {
        const item = views[key], Icon = item.icon, busy = key === 'tasks' ? active + queued : 0
        return <Link key={key} to={item.path} title={item.title} aria-current={key === view ? 'page' : undefined} className={cn('nav-item', key === view && 'active')}>
          <Icon size={16} strokeWidth={1.8} /><span className="nav-label">{item.title}</span>
          {busy > 0 && <span className="nav-badge" title={`${active} 张处理中，${queued} 张排队中`}>{busy}</span>}
        </Link>
      })}</nav>
      <div className="mt-auto flex items-center gap-2 rounded-lg bg-surface p-2.5 max-[800px]:flex-col max-[800px]:bg-transparent max-[800px]:p-0">
        <div className="sidebar-detail min-w-0 flex-1 text-xs"><p className="font-semibold">管理员</p><p className="mt-0.5 truncate text-muted-foreground">{data.settings.storage === 'oss' ? '阿里云 OSS' : '本地存储'} · v0.1.0</p></div>
        <button title="退出登录" aria-label="退出登录" className="row-action" onClick={() => void logout()}><LogOut size={15} /></button>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <h1>{meta.title}</h1>
        <span role="status" className={cn('topbar-meta ml-auto flex items-center gap-2 text-xs whitespace-nowrap', networkError ? 'text-bad-ink' : 'text-muted-foreground')}><span className={cn('status-dot', networkError && '!bg-bad !shadow-[0_0_0_3px_var(--bad-soft)]')} />{networkError ? '连接已断开' : '服务运行中 · 每 3 秒更新'}</span>
        <div className="flex items-center gap-2 max-[800px]:ml-auto">
          {view === 'overview' && <Button size="sm" variant="outline" asChild><Link to="/keys"><Code2 /><span className="btn-label">API 接入</span></Link></Button>}
          {view === 'accounts' ? <Button size="sm" onClick={() => setImportOpen(true)}><Plus /><span className="btn-label">添加账号</span></Button> : view === 'keys' ? <Button size="sm" onClick={() => setKeyOpen(true)}><Plus /><span className="btn-label">创建密钥</span></Button> : view !== 'settings' && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus /><span className="btn-label">新建任务</span></Button>}
        </div>
      </header>
      {networkError && <div role="alert" className="flex items-center gap-2 border-b border-bad/30 bg-bad-soft px-5 py-2 text-[13px] text-bad-ink"><WifiOff size={15} />与服务的连接已断开，页面数据可能不是最新，正在自动重连…</div>}
      <div className="content">
        {view === 'overview' && <Overview data={data} create={() => setCreateOpen(true)} importAccount={() => setImportOpen(true)} openTask={openTask} createKey={() => setKeyOpen(true)} />}
        {view === 'accounts' && <Accounts data={data} add={() => setImportOpen(true)} action={action} />}
        {view === 'tasks' && <Tasks data={data} create={() => setCreateOpen(true)} openTask={openTask} />}
        {view === 'keys' && <Keys data={data} add={() => setKeyOpen(true)} action={action} />}
        {view === 'settings' && <SettingsForm initial={data.settings} reload={load} />}
      </div>
    </main>
    <CreateTask open={createOpen} onOpenChange={setCreateOpen} data={data} complete={async task => { await load(); openTask(task.id) }} />
    <ImportAccounts open={importOpen} onOpenChange={setImportOpen} complete={load} />
    <CreateKey open={keyOpen} onOpenChange={setKeyOpen} complete={load} />
    <TaskDetail now={data.serverTime} id={detail} listed={data.tasks.find(t => t.id === detail)} open={!!detail && (view === 'overview' || view === 'tasks')} onOpenChange={value => !value && closeTask()} action={action} />
  </div>
}
