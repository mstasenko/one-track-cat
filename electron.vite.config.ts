import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    resolve: {
      alias: { '@shared': resolve('src') }
    }
  },
  preload: {
    resolve: {
      alias: { '@shared': resolve('src') }
    },
    build: {
      lib: {
        entry: resolve('src/preload.ts')
      },
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: { '@shared': resolve('src') }
    },
    plugins: [react()]
  }
})
