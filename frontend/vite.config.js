import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:8000',
      '/journeys': 'http://localhost:8000',
      '/signals': 'http://localhost:8000',
      '/emergencies': 'http://localhost:8000',
      '/internal': 'http://localhost:8000',
      '/settings': 'http://localhost:8000',
      '/assistant': 'http://localhost:8000',
      '/monitor': 'http://localhost:8000',
    },
  },
})
