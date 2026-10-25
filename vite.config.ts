import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // src/platform.ts: the web build is never the extension build
  // (vite.extension.config.ts inherits this file and flips it to true).
  define: { __KAILAH_EXTENSION__: 'false' },
  server: { port: 5173 },
})
