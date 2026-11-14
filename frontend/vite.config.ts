import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.VITE_BACKEND_URL ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: {
    // Same-origin in dev: the browser only ever talks to Vite.
    proxy: {
      '/api': backend,
      '/media': backend,
      '/ws': { target: backend, ws: true },
    },
  },
})
