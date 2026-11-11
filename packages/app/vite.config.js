import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

/**
 * The board module is not vendored here: point BOARD_MODULE at the file — any ES
 * module exporting {id, name, description, register(ctx)} — or drop it at
 * vendored/board/plugin.js.
 */
const boardModule =
  process.env.BOARD_MODULE || process.env.npm_config_board_module || resolve(root, 'vendored/board/plugin.js')

export default defineConfig({
  plugins: [react()],
  // Served by the bridge at /board/ (and as the SPA fallback for its routes).
  base: '/board/',
  server: {
    port: 5173,
    strictPort: true,
    // The app calls the engine by relative URL, so dev has the same origin it
    // will have in production.
    proxy: {
      '/rpc': 'http://127.0.0.1:8790',
      '/events': 'http://127.0.0.1:8790',
      '/boards': 'http://127.0.0.1:8790',
      '/sharing': 'http://127.0.0.1:8790',
      '/inbox': 'http://127.0.0.1:8790',
      '/health': 'http://127.0.0.1:8790',
      '/agents': 'http://127.0.0.1:8790'
    },
    fs: { allow: [root] }
  },
  resolve: {
    alias: [
      // react first: the board module resolves its imports from its own directory,
      // which has no node_modules of its own.
      { find: /^react\/jsx-runtime$/, replacement: resolve(here, 'node_modules/react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolve(here, 'node_modules/react/jsx-dev-runtime.js') },
      { find: /^react-dom\/client$/, replacement: resolve(here, 'node_modules/react-dom/client.js') },
      { find: /^react$/, replacement: resolve(here, 'node_modules/react/index.js') },
      { find: '@throughline/board-host', replacement: resolve(here, '../board-host/src/index.js') },
      // The specifier a board module imports its host from.
      { find: '@hermes/plugin-sdk', replacement: resolve(here, '../board-host/src/index.js') },
      { find: '@throughline/board-module', replacement: boardModule }
    ]
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false }
})
