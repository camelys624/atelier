import { useState } from 'react'
import { Pause, Play, RefreshCw, Search, ShieldCheck, Trash2, Upload, Users } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { Account, Snapshot } from '@/lib/client'
import { ConfirmDialog, Status, Tabs, type Action } from './shared'

type Filter = 'all' | 'web' | 'codex'

export function Accounts({ data, add, action }: { data: Snapshot; add: () => void; action: Action }) {
  const [filter, setFilter] = useState<Filter>('all'), [query, setQuery] = useState(''), [busy, setBusy] = useState<string | null>(null), [remove, setRemove] = useState<Account | null>(null)
  const q = query.trim().toLowerCase()
  const rows = data.accounts.filter(a => (filter === 'all' || a.source === filter) && `${a.name} ${a.email || ''}`.toLowerCase().includes(q))
  async function run(account: Account, path: string, value?: unknown, method?: string, message?: string) { setBusy(account.id); await action(path, value, method, message); setBusy(null) }
  const totalSuccess = data.accounts.reduce((sum, a) => sum + a.success, 0)
  const stats = [{ label: '已导入账号', value: data.accounts.length }, { label: '可参与调度', value: data.accounts.filter(a => a.status === 'ready').length }, { label: '当前生图占用', value: data.accounts.reduce((sum, a) => sum + a.inflight, 0) }]
  return <>
    <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
      {stats.map(item => <div className="panel px-5 py-5" key={item.label}><p className="text-[13px] text-soft">{item.label}</p><p className="mt-2 text-3xl font-medium tabular-nums tracking-tight">{item.value}</p></div>)}
    </div>
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-5 pt-4">
        <Tabs label="按来源筛选账号" value={filter} onChange={setFilter} items={[{ key: 'all', label: '全部', count: data.accounts.length }, { key: 'web', label: 'ChatGPT', count: data.accounts.filter(a => a.source === 'web').length }, { key: 'codex', label: 'Codex', count: data.accounts.filter(a => a.source === 'codex').length }]} />
        <div className="relative mb-3"><Search size={14} className="absolute left-3 top-2.5 text-faint" /><Input aria-label="搜索账号" placeholder="搜索账号名称或邮箱" className="h-9 w-56 pl-8 text-[13px]" value={query} onChange={e => setQuery(e.target.value)} /></div>
      </div>
      {rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left text-[13px]">
        <thead className="bg-surface text-xs text-muted-foreground"><tr>{['账号', '来源 / 套餐', '状态', '图片额度', '累计成功 / 失败', '并发（占用 / 上限）', ''].map((label, i) => <th className="px-5 py-3 font-normal" key={i}>{label}</th>)}</tr></thead>
        <tbody>{rows.map(account => {
          const working = busy === account.id || account.status === 'refreshing', disabled = account.status === 'disabled'
          return <tr key={account.id} className="border-t">
            <td className="max-w-60 px-5 py-4"><p className="truncate font-medium">{account.name}</p><p className="mt-1 truncate text-xs text-muted-foreground">{account.email || '等待读取账号资料'}</p>{account.last_error && <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#a1443a]" title={account.last_error}>{account.last_error}</p>}</td>
            <td className="px-5 py-4"><span className="pill">{account.source === 'codex' ? 'Codex' : 'ChatGPT'}</span><p className="mt-1.5 text-xs text-muted-foreground">{account.plan === 'unknown' ? '待识别套餐' : account.plan}</p></td>
            <td className="px-5 py-4"><Status value={account.status} /></td>
            <td className="px-5 py-4 tabular-nums text-soft">{account.quota === null ? <span className="text-muted-foreground" title="当前协议无法独立获取 Codex 图片额度">未获取</span> : `${account.quota} 张`}</td>
            <td className="px-5 py-4 tabular-nums" title={totalSuccess ? `占全部成功图片的 ${Math.round(account.success / totalSuccess * 100)}%` : undefined}>
              <p><span className="text-soft">{account.success}</span><span className="text-faint"> / </span><span className={account.fail ? 'text-[#a1443a]' : 'text-muted-foreground'}>{account.fail}</span></p>
              {totalSuccess > 0 && <div className="mt-1.5 flex items-center gap-2"><div className="h-1 w-16 overflow-hidden rounded-full bg-[#eef0e8]"><div className="h-full rounded-full bg-[#91a078]" style={{ width: `${account.success / totalSuccess * 100}%` }} /></div><span className="text-xs text-muted-foreground">{Math.round(account.success / totalSuccess * 100)}%</span></div>}
            </td>
            <td className="px-5 py-4"><div className="flex items-center gap-2">
              <span className="w-4 text-right tabular-nums text-soft">{account.inflight}</span><span className="text-faint">/</span>
              <select aria-label={`${account.name}的并发上限`} className="rounded-md border bg-white px-2 py-1 text-[13px] disabled:opacity-50" value={account.slots} disabled={busy === account.id} onChange={e => void run(account, `/api/accounts/${account.id}`, { slots: Number(e.target.value) }, 'PATCH', '并发上限已更新')}>{[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}</select>
            </div></td>
            <td className="px-4 py-4"><div className="flex justify-end gap-1">
              <button className="row-action" aria-label={`验证${account.name}`} title="验证与刷新" disabled={working} onClick={() => void run(account, `/api/accounts/${account.id}/refresh`, {}, undefined, '账号验证完成')}><RefreshCw size={15} className={working ? 'animate-spin' : ''} /></button>
              <button className="row-action" aria-label={disabled ? `启用${account.name}` : `停用${account.name}`} title={disabled ? '启用' : '停用'} disabled={busy === account.id} onClick={() => void run(account, `/api/accounts/${account.id}`, { enabled: disabled }, 'PATCH', disabled ? '账号已启用' : '账号已停用')}>{disabled ? <Play size={15} /> : <Pause size={15} />}</button>
              <button className="row-action hover:!text-red-600" aria-label={`删除${account.name}`} title="删除" onClick={() => setRemove(account)}><Trash2 size={15} /></button>
            </div></td>
          </tr>
        })}</tbody>
      </table></div> : <div className="py-20 text-center">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl border bg-[#f7f8f2] text-faint"><Users size={25} strokeWidth={1.3} /></div>
        {q ? <><h3 className="font-medium">没有匹配的账号</h3><p className="mt-2 text-[13px] text-muted-foreground">换个关键词试试。</p><Button className="mt-5" size="sm" variant="outline" onClick={() => setQuery('')}>清除搜索</Button></>
          : <><h3 className="font-medium">还没有{filter === 'codex' ? ' Codex ' : filter === 'web' ? ' ChatGPT ' : ''}账号</h3><p className="mx-auto mt-2 max-w-80 text-[13px] leading-6 text-muted-foreground">导入登录凭证并验证，系统会自动识别账号套餐，按空闲名额分配图片任务。</p><Button className="mt-5" size="sm" onClick={add}><Upload />添加账号</Button></>}
      </div>}
    </section>
    <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck size={13} />登录凭证已加密保存。Codex 图片额度暂不作为独立配额展示。</p>
    <ConfirmDialog open={!!remove} onOpenChange={open => !open && setRemove(null)} title="删除这个账号？" description={<>将移除「{remove?.name}」的登录凭证，已有任务记录会保留。</>} confirm="删除账号" onConfirm={async () => { if (await action(`/api/accounts/${remove!.id}`, undefined, 'DELETE', '账号已删除')) setRemove(null) }} />
  </>
}
