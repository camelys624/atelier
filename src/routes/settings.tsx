import { createFileRoute } from '@tanstack/react-router'
import { Console } from '@/components/console'
export const Route = createFileRoute('/settings')({ component: () => <Console view="settings" /> })
