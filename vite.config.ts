import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [tailwindcss(), tanstackStart({ spa: { enabled: true } }), react()],
  server: { proxy: Object.fromEntries(['/api', '/v1', '/media', '/health'].map(path => [path, 'http://127.0.0.1:3080'])) },
})
