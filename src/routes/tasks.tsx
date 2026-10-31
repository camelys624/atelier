import { createFileRoute } from '@tanstack/react-router'
import { Console } from '@/components/console'
export const Route = createFileRoute('/tasks')({ component: () => <Console view="tasks" /> })
