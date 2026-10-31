import * as React from 'react'
import * as Primitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
export const Dialog = Primitive.Root
export const DialogTrigger = Primitive.Trigger
export const DialogTitle = Primitive.Title
export const DialogDescription = Primitive.Description
export function DialogContent({ children, className, ...props }: React.ComponentProps<typeof Primitive.Content>) { return <Primitive.Portal><Primitive.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[3px] data-[state=open]:animate-in" /><Primitive.Content className={cn('fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border bg-background p-6 shadow-2xl focus:outline-none', className)} {...props}>{children}<Primitive.Close aria-label="关闭" className="absolute right-5 top-5 rounded-md p-1.5 text-muted-foreground hover:bg-muted"><X className="size-4" /></Primitive.Close></Primitive.Content></Primitive.Portal> }
