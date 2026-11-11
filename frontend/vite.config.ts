import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    allowedHosts: ['.vercel.run'],
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
