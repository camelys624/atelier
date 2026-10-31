import { useState, type ReactNode } from 'react'
import { Image as ImageIcon, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { cn } from '@/lib/utils'

export type Action = (path: string, value?: unknown, method?: string, message?: string) => Promise<boolean>

export const statuses: Record<string, { text: string; color: string }> = { ready: { text: '可用', color: 'green' }, pending: { text: '待验证', color: 'amber' }, refreshing: { text: '验证中', color: 'blue' }, disabled: { text: '已停用', color: '' }, limited: { text: '额度用尽', color: 'amber' }, queued: { text: '排队中', color: 'amber' }, running: { text: '生成中', color: 'blue' }, generating: { text: '生成中', color: 'blue' }, uploading: { text: '上传中', color: 'blue' }, success: { text: '已完成', color: 'green' }, partial: { text: '部分完成', color: 'amber' }, error: { text: '失败', color: 'red' }, cancelled: { text: '已取消', color: '' }, revoked: { text: '已撤销', color: '' } }
export const time = (n: number | null) => n ? new Date(n).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
export const short = (s: string) => s.slice(-8)

export function Status({ value }: { value: string }) {
  const status = statuses[value] || { text: value, color: '' }
  return <span className={cn('pill', status.color)}><span className="size-1.5 rounded-full bg-current" />{status.text}</span>
}

export function Brand() {
  return <div className="wordmark"><span className="brand-icon">a</span><span className="brand-name">atelier<span className="text-accent">.</span></span></div>
}

export function Field({ label, help, children, className }: { label: string; help?: ReactNode; children: ReactNode; className?: string }) {
  return <label className={className}><span className="field-label">{label}</span>{children}{help && <p className="field-help">{help}</p>}</label>
}

export async function copy(value: string, message = '已复制') {
  try { await navigator.clipboard.writeText(value); toast.success(message) } catch { toast.error('无法复制，请手动选择文本') }
}

export function EmptyArt() {
  return <div className="empty-art" aria-hidden><div className="sheet" /><div className="sheet" /><div className="sheet"><ImageIcon size={25} strokeWidth={1.2} /></div><span className="absolute bottom-1 right-0 flex size-6 items-center justify-center rounded-full border-3 border-white bg-accent-soft text-accent-text"><Plus size={13} /></span></div>
}

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (value: T) => void; items: { key: T; label: string; count?: number; alert?: boolean }[]; label: string }) {
  return <div role="tablist" aria-label={label} className="tabs">
    {items.map(item => <button key={item.key} role="tab" type="button" aria-selected={value === item.key} className="tab" onClick={() => onChange(item.key)}>
      {item.label}
      {item.count !== undefined && <span className={cn('tab-count', item.alert && item.count > 0 && 'alert')}>{item.count}</span>}
    </button>)}
  </div>
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirm, onConfirm }: { open: boolean; onOpenChange: (value: boolean) => void; title: string; description: ReactNode; confirm: string; onConfirm: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  return <Dialog open={open} onOpenChange={value => !busy && onOpenChange(value)}>
    <DialogContent>
      <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
      <DialogDescription className="mt-3 text-sm leading-6 text-muted-foreground">{description}</DialogDescription>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
        <Button variant="destructive" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm() } finally { setBusy(false) } }}>{busy && <Loader2 className="animate-spin" />}{confirm}</Button>
      </div>
    </DialogContent>
  </Dialog>
}
