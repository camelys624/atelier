import { createFileRoute } from '@tanstack/react-router'
import { Console } from '@/components/console'
export const Route = createFileRoute('/accounts')({ component: () => <Console view="accounts" /> })
