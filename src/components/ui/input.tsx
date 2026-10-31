import * as React from 'react'
import { cn } from '@/lib/utils'
export function Input({ className, ...props }: React.ComponentProps<'input'>) { return <input className={cn('flex h-10 w-full rounded-lg border border-input bg-background px-3 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', className)} {...props} /> }
export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) { return <textarea className={cn('flex min-h-24 w-full rounded-lg border border-input bg-background px-3 py-3 text-sm leading-6 shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} {...props} /> }
