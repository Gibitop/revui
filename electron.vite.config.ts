import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } },
  },
  renderer: {
    worker: { format: 'es' },
    build: { minify: 'esbuild' },
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'renderer-csp',
        transformIndexHtml(html, context) {
          return html.replace('__DEV_SCRIPT__', context.server ? "'unsafe-inline'" : '')
            .replace('__DEV_CONNECT__', context.server ? 'ws://localhost:* ws://127.0.0.1:*' : '')
        },
      },
    ],
  },
})
