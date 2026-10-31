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
const views = { overview: { title: '运行概览', description: '账号、队列与图片交付的整体情况。', path: '/', icon: LayoutDashboard }, accounts: { title: '账号池', description: '管理参与调度的账号，查看验证状态与额度。', path: '/accounts', icon: Users }, tasks: { title: '任务队列', description: '查看生成进度与结果，失败图片可以单独重试。', path: '/tasks', icon: Layers2 }, keys: { title: 'API 密钥', description: '为业务创建独立密钥，接入图片生成接口。', path: '/keys', icon: KeyRound }, settings: { title: '服务设置', description: '配置调度并发、图片存储与参考图来源。', path: '/settings', icon: Settings2 } } as const

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
      <nav className="mt-10" aria-label="主导航">{(Object.keys(views) as View[]).map(key => {
        const item = views[key], Icon = item.icon, busy = key === 'tasks' ? active + queued : 0
        return <Link key={key} to={item.path} title={item.title} aria-current={key === view ? 'page' : undefined} className={cn('nav-item', key === view && 'active')}>
          <Icon size={17} strokeWidth={1.7} /><span className="nav-label">{item.title}</span>
          {busy > 0 && <span className="nav-badge" title={`${active} 张处理中，${queued} 张排队中`}>{busy}</span>}
        </Link>
      })}</nav>
      <div className="mt-auto flex items-center gap-2 border-t border-[#dfe2d6] px-3 pt-4 max-[800px]:flex-col max-[800px]:px-0">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#e0e3d6] text-[11px] font-semibold text-[#5d6550]">AD</span>
        <p className="sidebar-detail text-[13px] font-medium">管理员</p>
        <button title="退出登录" aria-label="退出登录" className="row-action ml-auto max-[800px]:ml-0" onClick={() => void logout()}><LogOut size={15} /></button>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <span className="text-[13px] font-medium text-soft">{meta.title}</span>
        <div className="flex items-center gap-5">
          <span role="status" className={cn('flex items-center gap-2 text-xs', networkError ? 'text-[#a1443a]' : 'text-muted-foreground')}><span className={cn('status-dot', networkError && '!bg-[#c4554a] !shadow-[0_0_0_3px_#c4554a22]')} />{networkError ? '连接已断开' : '服务运行中'}</span>
          <span className="hidden border-l pl-5 text-xs text-muted-foreground sm:block">v0.1.0</span>
        </div>
      </header>
      {networkError && <div role="alert" className="flex items-center gap-2 border-b border-[#efd6d0] bg-[#fbf0ed] px-[38px] py-2.5 text-[13px] text-[#8f3f35] max-[1100px]:px-6 max-[800px]:px-[18px]"><WifiOff size={15} />与服务的连接已断开，页面数据可能不是最新，正在自动重连…</div>}
      <div className="content">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div><h1 className="page-title">{meta.title}</h1><p className="mt-2 text-[13px] text-muted-foreground">{meta.description}</p></div>
          <div className="flex items-center gap-2.5">
            {view === 'overview' && <Button variant="outline" asChild><Link to="/keys"><Code2 />API 接入</Link></Button>}
            {view === 'accounts' ? <Button onClick={() => setImportOpen(true)}><Plus />添加账号</Button> : view === 'keys' ? <Button onClick={() => setKeyOpen(true)}><Plus />创建密钥</Button> : view !== 'settings' && <Button onClick={() => setCreateOpen(true)}><Plus />新建生图任务</Button>}
          </div>
        </div>
        {view === 'overview' && <Overview data={data} online={!networkError} create={() => setCreateOpen(true)} importAccount={() => setImportOpen(true)} openTask={openTask} createKey={() => setKeyOpen(true)} />}
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
