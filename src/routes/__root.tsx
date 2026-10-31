import { ClientOnly, createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { Toaster } from 'sonner'
import type { ReactNode } from 'react'
import stylesUrl from '../styles.css?url'
export const Route = createRootRoute({ head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Atelier · 生图服务' }, { name: 'description', content: '轻量、可控的生图服务。账号池、任务队列与图片存储，尽在一处。' }], links: [{ rel: 'stylesheet', href: stylesUrl }] }), component: AppContent, shellComponent: RootDocument, notFoundComponent: () => <div className="p-20 text-center">页面不存在，<a href="/">返回概览</a></div> })
function AppContent() { return <ClientOnly><Outlet /></ClientOnly> }
function RootDocument({ children }: { children: ReactNode }) { return <html lang="zh-CN"><head><HeadContent /></head><body>{children}<Toaster richColors position="top-center" /><Scripts /></body></html> }
