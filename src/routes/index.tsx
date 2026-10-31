import { createFileRoute } from '@tanstack/react-router'
import { Console } from '@/components/console'
import { validateTaskSearch } from '@/lib/search'
export const Route = createFileRoute('/')({ validateSearch: validateTaskSearch, component: () => <Console view="overview" /> })
