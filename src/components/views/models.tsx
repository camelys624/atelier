import { useEffect, useRef, useState } from 'react'
import { Boxes, Check, ChevronDown, Loader2, Pencil, Plus, Power, Search, Star, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Input, Textarea } from '../ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { cn } from '@/lib/utils'
import type { Model } from '@/lib/client'
import { ConfirmDialog, Field, type Action } from './shared'

const qualities = [['auto', '自动'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '超高'], ['max', '最高']] as const
type Draft = Pick<Model, 'id' | 'name' | 'source' | 'description' | 'qualities' | 'enabled'> & { sizesText: string }
const emptyDraft = (): Draft => ({ id: '', name: '', source: 'codex', description: '', qualities: ['auto', 'low', 'medium', 'high'], sizesText: '1024x1024\n1536x1024\n1024x1536\nauto', enabled: true })

export function Models({ models, responsesModel, action }: { models: Model[]; responsesModel: string; action: Action }) {
  const [editor, setEditor] = useState<Model | 'new' | null>(null), [removing, setRemoving] = useState<Model | null>(null), [query, setQuery] = useState(''), [pending, setPending] = useState<string | null>(null)
  const currentDefault = models.find(model => model.isDefault)
  const filtered = models.filter(model => `${model.id} ${model.name} ${model.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  async function mutate(model: Model, makeDefault = false) {
    setPending(model.id)
    try { await action(`/api/models/${model.id}${makeDefault ? '/default' : ''}`, makeDefault ? {} : { enabled: !model.enabled }, makeDefault ? 'POST' : 'PATCH', makeDefault ? '默认模型已更新' : model.enabled ? '模型已停用' : '模型已启用') }
    finally { setPending(null) }
  }
  return <div className="grid min-w-0 gap-3.5">
    <section className="panel flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-4">
      <div className="flex min-w-0 items-center gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text"><Star size={18} /></span><div className="min-w-0"><p className="mb-1 text-xs text-muted-foreground">默认生图模型</p><p className="break-all font-mono text-[13px] font-medium">{currentDefault?.id}</p></div></div>
      <p className="max-w-lg text-xs leading-6 text-muted-foreground">请求未指定模型时使用默认模型。修改后立即生效，已提交的任务继续使用原模型。</p>
      <span className="pill ml-auto">{models.filter(model => model.enabled).length} / {models.length} 个已启用</span>
    </section>
    <section className="panel overflow-hidden">
      <div className="panel-heading flex-wrap gap-3">
        <div className="flex items-center gap-2.5"><Boxes size={17} className="text-faint" /><h2 className="panel-title">生图模型</h2></div>
        <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">
          <div className="relative w-52 max-w-full"><Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-faint" /><Input aria-label="搜索模型" className="h-8 pl-8" placeholder="搜索名称或模型 ID" value={query} onChange={event => setQuery(event.target.value)} /></div>
          <Button size="sm" onClick={() => setEditor('new')}><Plus />添加模型</Button>
        </div>
      </div>
      <div className="overflow-x-auto"><table className="models-table w-full text-left text-[13px]">
        <thead className="bg-surface text-xs text-muted-foreground"><tr>{['模型', '账号来源', '尺寸与质量', '状态', '操作'].map(label => <th key={label} className="px-4 py-2.5 font-normal">{label}</th>)}</tr></thead>
        <tbody>{filtered.map(model => <tr key={model.id} className={cn('border-t align-top', !model.enabled && 'bg-surface/60')}>
          <td className="max-w-[320px] px-4 py-4"><div className="mb-1.5 flex flex-wrap items-center gap-2"><span className="font-medium">{model.name}</span>{model.isDefault && <span className="pill blue"><Star size={10} />默认</span>}</div><code className="break-all text-xs text-muted-foreground">{model.id}</code>{model.description && <p className="mt-2 max-w-72 text-xs leading-5 text-muted-foreground">{model.description}</p>}</td>
          <td className="px-4 py-4"><span className="pill">{model.source === 'codex' ? 'Codex' : 'ChatGPT 网页'}</span></td>
          <td data-label="尺寸与质量" className="max-w-64 px-4 py-4"><p className="font-mono text-[11px] leading-5 text-muted-foreground">{model.sizes.join(' · ')}</p><p className="mt-2 text-xs leading-5 text-soft">{model.qualities.join(' / ')}</p></td>
          <td className="px-4 py-4"><span className={cn('pill', model.enabled && 'green')}>{model.enabled ? '已启用' : '已停用'}</span>{model.enabled && <p className={cn('mt-2 text-xs', model.accounts ? 'text-muted-foreground' : 'text-warn-ink')}>{model.accounts ? `${model.accounts} 个可用账号` : '无可用账号'}</p>}</td>
          <td className="px-4 py-3"><div className="flex items-center gap-1">
            <button className="row-action" aria-label={`编辑 ${model.id}`} title="编辑模型" onClick={() => setEditor(model)}><Pencil size={15} /></button>
            <button className="row-action" aria-label={`${model.enabled ? '停用' : '启用'} ${model.id}`} title={model.isDefault ? '请先切换默认模型' : model.enabled ? '停用模型' : '启用模型'} disabled={model.isDefault || pending !== null} onClick={() => void mutate(model)}>{pending === model.id ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}</button>
            <button className="row-action hover:!text-bad-ink" aria-label={`删除 ${model.id}`} title={model.isDefault ? '请先切换默认模型' : '删除模型'} disabled={model.isDefault || pending !== null} onClick={() => setRemoving(model)}><Trash2 size={15} /></button>
          </div>{!model.isDefault && <button className="mt-1 rounded px-1.5 py-1 text-xs text-accent-text hover:bg-accent-soft disabled:opacity-40" disabled={!model.enabled || pending !== null} onClick={() => void mutate(model, true)}>设为默认<span className="sr-only"> {model.id}</span></button>}</td>
        </tr>)}</tbody>
      </table></div>
      {!filtered.length && <p className="px-4 py-14 text-center text-sm text-muted-foreground">没有找到匹配的模型。</p>}
      <p className="border-t px-4 py-3 text-xs leading-6 text-muted-foreground">启用的模型会出现在任务创建和 API 模型列表中。可用账号数量按账号来源计算，模型的实际访问权限由上游账号决定。</p>
    </section>
    <CallingModel initial={responsesModel} action={action} />
    {editor !== null && <ModelEditor initial={editor === 'new' ? null : editor} onClose={() => setEditor(null)} action={action} />}
    <ConfirmDialog open={removing !== null} onOpenChange={open => !open && setRemoving(null)} title="删除这个模型？" description={<>删除「{removing?.name}」后，新的任务将无法选择它。已提交的任务和历史记录会保留。</>} confirm="删除模型" onConfirm={async () => { if (removing && await action(`/api/models/${removing.id}`, undefined, 'DELETE', '模型已删除')) setRemoving(null) }} />
  </div>
}

function CallingModel({ initial, action }: { initial: string; action: Action }) {
  const [value, setValue] = useState(initial), [busy, setBusy] = useState(false)
  const baseline = useRef(initial)
  useEffect(() => { const previous = baseline.current; baseline.current = initial; setValue(draft => draft === previous ? initial : draft) }, [initial])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try { await action('/api/model-settings', { responsesModel: value.trim() }, 'POST', 'Codex 调用模型已保存') }
    finally { setBusy(false) }
  }
  return <details className="panel group">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-[13px] font-medium [&::-webkit-details-marker]:hidden">Codex 调用设置<ChevronDown size={15} className="text-faint transition-transform group-open:rotate-180" /></summary>
    <form className="border-t p-4" onSubmit={save}>
      <p className="mb-4 max-w-2xl text-xs leading-6 text-muted-foreground">Codex 使用这个文本模型调用图片工具。它与上方的生图模型分别设置，客户端仍然填写生图模型 ID。修改后用于新发起的生成请求。</p>
      <div className="flex max-w-xl flex-wrap items-end gap-3"><Field className="min-w-52 flex-1" label="Codex 调用模型"><Input value={value} onChange={event => setValue(event.target.value)} disabled={busy} required maxLength={128} placeholder="gpt-6.1-sol" /></Field><Button type="submit" disabled={busy || !value.trim() || value.trim() === initial}>{busy && <Loader2 className="animate-spin" />}保存调用设置</Button></div>
    </form>
  </details>
}

function ModelEditor({ initial, onClose, action }: { initial: Model | null; onClose: () => void; action: Action }) {
  const [draft, setDraft] = useState<Draft>(() => initial ? { id: initial.id, name: initial.name, source: initial.source, description: initial.description, qualities: [...initial.qualities], sizesText: initial.sizes.join('\n'), enabled: initial.enabled } : emptyDraft())
  const [busy, setBusy] = useState(false)
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }))
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !draft.qualities.length) return
    setBusy(true)
    const { sizesText, ...fields } = draft
    try { if (await action(initial ? `/api/models/${initial.id}` : '/api/models', { ...fields, sizes: sizesText.split(/[\s,，]+/).filter(Boolean) }, initial ? 'PATCH' : 'POST', initial ? '模型配置已保存，立即生效' : '模型已添加')) onClose() }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => !open && !busy && onClose()}><DialogContent className="!max-w-[600px]">
    <DialogTitle className="text-xl font-semibold">{initial ? '编辑模型' : '添加生图模型'}</DialogTitle>
    <DialogDescription className="mt-2 text-[13px] leading-6 text-muted-foreground">设置模型使用的账号来源和支持的参数，保存后立即用于新的任务。</DialogDescription>
    <form className="mt-6 space-y-5" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="模型 ID" help={initial ? '模型 ID 不可修改。需要更换时请添加新模型。' : '填写账号支持的上游模型名，例如 gpt-image-2.6-flare。'}><Input value={draft.id} onChange={event => change('id', event.target.value)} disabled={!!initial || busy} required maxLength={128} placeholder="gpt-image-…" autoFocus={!initial} autoComplete="off" pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*" /></Field>
        <Field label="显示名称"><Input value={draft.name} onChange={event => change('name', event.target.value)} disabled={busy} required maxLength={100} placeholder="例如 GPT Image 2.6 Flare" autoFocus={!!initial} /></Field>
        <Field label="账号来源" help="ChatGPT 网页来源目前仅支持 gpt-image-2。"><select className="select" value={draft.source} onChange={event => change('source', event.target.value as Draft['source'])} disabled={busy || !!initial}><option value="codex">Codex</option><option value="web">ChatGPT 网页</option></select></Field>
        <Field label="说明（可选）"><Input value={draft.description} onChange={event => change('description', event.target.value)} disabled={busy} maxLength={500} placeholder="例如适合精细构图和图片编辑" /></Field>
      </div>
      <Field label="支持的尺寸" help="每行一个尺寸，也可用逗号分隔。第一个明确尺寸为默认值；可加入 auto。宽高为 16 的倍数，比例介于 1:3～3:1。"><Textarea className="min-h-24 font-mono text-xs" value={draft.sizesText} onChange={event => change('sizesText', event.target.value)} disabled={busy} required rows={4} /></Field>
      <fieldset disabled={busy}><legend className="field-label">支持的质量档位</legend><div className="flex flex-wrap gap-2">{qualities.map(([value, label]) => <label key={value} className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs', draft.qualities.includes(value) ? 'border-accent/40 bg-accent-soft text-accent-text' : 'text-muted-foreground')}><input className="accent-accent" type="checkbox" checked={draft.qualities.includes(value)} onChange={event => change('qualities', qualities.map(([quality]) => quality).filter(quality => quality === value ? event.target.checked : draft.qualities.includes(quality)))} />{value}<span className="text-[11px] opacity-70">{label}</span></label>)}</div>{!draft.qualities.length && <p role="alert" className="mt-2 text-xs text-bad-ink">至少选择一个质量档位。</p>}</fieldset>
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-surface px-3 py-3"><input type="checkbox" className="mt-0.5 accent-accent" checked={draft.enabled} disabled={busy || initial?.isDefault} onChange={event => change('enabled', event.target.checked)} /><span><span className="text-[13px] font-medium">启用这个模型</span><span className="mt-1 block text-xs text-muted-foreground">{initial?.isDefault ? '默认模型需要保持启用。如需停用，请先切换默认模型。' : '停用后不接受新的任务，已提交的任务继续执行。'}</span></span></label>
      <div className="flex justify-end gap-2 border-t pt-4"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !draft.qualities.length}>{busy ? <Loader2 className="animate-spin" /> : <Check />}{initial ? '保存配置' : '添加模型'}</Button></div>
    </form>
  </DialogContent></Dialog>
}
