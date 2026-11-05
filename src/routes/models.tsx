import { createFileRoute } from '@tanstack/react-router'
import { Console } from '@/components/console'
export const Route = createFileRoute('/models')({ component: () => <Console view="models" /> })
