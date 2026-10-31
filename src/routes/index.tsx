import { createFileRoute } from '@tanstack/react-router'
import { Console } from '@/components/console'
export const Route = createFileRoute('/')({ component: () => <Console view="overview" /> })
