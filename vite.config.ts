import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const devBackendUrl = process.env.KARUTA_DEV_BACKEND_URL || 'http://127.0.0.1:8787'
const devBackendWsUrl = devBackendUrl.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/scheduler')) {
            return 'react'
          }
          if (id.includes('node_modules/react-router')) return 'router'
          if (id.includes('node_modules/idb')) return 'idb'
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': devBackendUrl,
      '/ws': {
        target: devBackendWsUrl,
        ws: true,
      },
    },
  },
  preview: {
    host: true,
    port: 4173,
  },
})
