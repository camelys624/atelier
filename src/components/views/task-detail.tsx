import { useEffect, useState } from 'react'
import * as Primitive from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, Clock3, Copy, ExternalLink, Image as ImageIcon, Loader2, Maximize2, RefreshCw, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { api, type ImageResult, type Task } from '@/lib/client'
import { formatDuration, imageTiming, taskTiming } from '@/lib/timing'
import { ConfirmDialog, Status, copy, statuses, time, type Action } from './shared'

function Lightbox({ images, index, onIndex }: { images: ImageResult[]; index: number | null; onIndex: (value: number | null) => void }) {
  const image = index === null ? null : images[index]
  const step = (delta: number) => index !== null && images.length > 1 && onIndex((index + delta + images.length) % images.length)
  return <Primitive.Root open={!!image} onOpenChange={value => !value && onIndex(null)}>
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-[60] bg-[#151713]/90 backdrop-blur-sm" />
      <Primitive.Content aria-describedby={undefined} className="fixed inset-0 z-[60] flex flex-col focus:outline-none" onKeyDown={e => { if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1) }}>
        <Primitive.Title className="sr-only">图片预览</Primitive.Title>
        <div className="flex items-center justify-between gap-3 px-5 py-4 text-sm text-white/80">
          <span className="tabular-nums">第 {image ? image.position + 1 : ''} 张{images.length > 1 && <span className="ml-2 text-white/50">{(index ?? 0) + 1} / {images.length}</span>}</span>
          <div className="flex items-center gap-1">
            {image?.url && <a href={image.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg px-3 py-2 hover:bg-white/10">打开原图<ExternalLink size={14} /></a>}
            {image?.url && <button className="rounded-lg p-2 hover:bg-white/10" aria-label="复制图片地址" onClick={() => void copy(image.url!, '图片地址已复制')}><Copy size={16} /></button>}
            <Primitive.Close className="rounded-lg p-2 hover:bg-white/10" aria-label="关闭预览"><X size={18} /></Primitive.Close>
          </div>
        </div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6 sm:px-16" onClick={e => e.target === e.currentTarget && onIndex(null)}>
          {image?.url && <img src={image.url} alt={`第 ${image.position + 1} 张图片`} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />}
          {images.length > 1 && <>
            <button aria-label="上一张" onClick={() => step(-1)} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20 sm:left-4"><ChevronLeft size={20} /></button>
            <button aria-label="下一张" onClick={() => step(1)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20 sm:right-4"><ChevronRight size={20} /></button>
          </>}
        </div>
      </Primitive.Content>
    </Primitive.Portal>
  </Primitive.Root>
}

export function TaskDetail({ id, listed, open, onOpenChange, action, now }: { id: string | undefined; listed?: Task; now: number; open: boolean; onOpenChange: (value: boolean) => void; action: Action }) {
  const [fetched, setFetched] = useState<Task | null>(null), [missing, setMissing] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null), [confirmCancel, setConfirmCancel] = useState(false)
  useEffect(() => { setViewing(null); setFetched(null); setMissing(false) }, [id])
  // Tasks older than the 100 listed in the snapshot are loaded by id, refreshed on each poll.
  useEffect(() => {
    if (!open || !id || listed) return
    let disposed = false
    api<Task>(`/api/tasks/${encodeURIComponent(id)}`).then(value => { if (!disposed) setFetched(value) }).catch((error: any) => { if (!disposed && error.status === 404) setMissing(true) })
    return () => { disposed = true }
  }, [open, id, !!listed, now])
  const task = listed || fetched
  const viewable = task?.images.filter(i => i.status === 'success' && i.url) || []
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="!max-w-[880px]">
    <DialogTitle className="flex items-center gap-3 pr-8 text-xl font-semibold">任务详情{task && <Status value={task.status} />}</DialogTitle>
    <DialogDescription className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      {task ? <><button className="font-mono hover:text-foreground" title="复制任务 ID" onClick={() => void copy(task.id, '任务 ID 已复制')}>{task.id}</button><span>·</span><span>{time(task.created)}</span></> : missing ? '找不到这个任务，可能已被删除。' : '正在读取任务…'}
    </DialogDescription>
    {task && <>
      <div className="mt-6 rounded-lg border bg-surface p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{task.model}</span><span>·</span><span>{task.n} 张图片</span>{task.demo && <span className="pill amber">本地演示 · 非真实生图</span>}</div>
        <p className="whitespace-pre-wrap text-[13px] leading-6">{task.prompt}</p>
      </div>
      <div className="my-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted-foreground">
          <span>已交付 <span className="tabular-nums text-foreground">{task.completed} / {task.n}</span> 张{task.failed > 0 && <span className="ml-2 text-[#a1443a]">{task.failed} 张失败</span>}</span>
          <span className="flex items-center gap-1.5" title="从提交到结束，包含排队等待"><Clock3 size={13} />总耗时 <span className="tabular-nums text-foreground">{formatDuration(taskTiming(task, now).total)}</span></span>
        </div>
        <div className="flex flex-wrap gap-2">
          {task.failed > 0 && <Button size="sm" variant="outline" onClick={() => action(`/api/tasks/${task.id}/retry`, {}, undefined, '失败图片已重新排队；已有结果仅重传')}><RefreshCw />重试失败图片</Button>}
          {['queued', 'running'].includes(task.status) && <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}><X />取消排队</Button>}
          <Button size="sm" variant="outline" disabled={!task.completed} onClick={() => void copy(task.images.filter(i => i.url).map(i => i.url).join('\n'), '结果地址已复制')}><Copy />复制结果地址</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {task.images.map((image, index) => {
          const timing = imageTiming(image, task, now), viewIndex = viewable.indexOf(image)
          return <div key={image.id} className="overflow-hidden rounded-xl border">
            <div className="relative aspect-[4/5] bg-[#f3f5ed]">
              {viewIndex >= 0 ? <button className="group size-full" aria-label={`查看第 ${index + 1} 张大图`} onClick={() => setViewing(viewIndex)}>
                <img className="size-full object-cover" src={image.url!} alt={`第 ${index + 1} 张${task.demo ? '演示' : '生成'}图片`} loading="lazy" />
                <span className="absolute right-2 top-2 rounded-md bg-black/45 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Maximize2 size={13} /></span>
              </button> : <div className="flex size-full flex-col items-center justify-center gap-3 text-muted-foreground">
                {['generating', 'uploading'].includes(image.status) ? <Loader2 className="animate-spin" size={22} /> : image.status === 'error' ? <X size={23} className="text-[#a1443a]" /> : <ImageIcon size={23} strokeWidth={1.3} />}
                <span className="text-xs">{statuses[image.status]?.text || image.status}</span>
              </div>}
            </div>
            <div className="flex items-center justify-between px-3 py-2.5"><span className="text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><Status value={image.status} /></div>
            <div className="space-y-1 border-t bg-surface px-3 py-2 text-xs text-muted-foreground">
              <p className="flex items-center justify-between gap-2" title="含参考图读取、生图与上传"><span>处理</span><span className="tabular-nums text-soft">{formatDuration(timing.processing)}</span></p>
              <p className="flex items-center justify-between gap-2"><span>{image.status === 'queued' ? '已排队' : '排队等待'}</span><span className="tabular-nums">{formatDuration(timing.waiting)}</span></p>
            </div>
            {image.error && <p className="border-t px-3 py-2 text-xs leading-5 text-[#a1443a]">{image.error}</p>}
          </div>
        })}
      </div>
      <Lightbox images={viewable} index={viewing} onIndex={setViewing} />
      <ConfirmDialog open={confirmCancel} onOpenChange={setConfirmCancel} title="取消排队中的图片？" description="尚未开始的图片将被取消，且无法恢复；正在生成的图片仍会完成并保存。" confirm="取消排队" onConfirm={async () => { if (await action(`/api/tasks/${task.id}/cancel`, {}, undefined, '已取消尚未开始的图片')) setConfirmCancel(false) }} />
    </>}
  </DialogContent></Dialog>
}
