// Second build target: the same app packaged as a Manifest V3 browser
// extension.
//   npm run build:extension  →  dist-extension/  (load unpacked, or zip for the store)
//
// It inherits everything from vite.config.ts (the web build), so a setting
// added there reaches the extension too, and only adds what an extension
// needs. Nothing here changes the web build. See docs/extension.md.

import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import web from './vite.config'
import { kailahExtension } from './extension/plugin'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default mergeConfig(
  web,
  defineConfig({
    plugins: [kailahExtension()],
    define: { __KAILAH_EXTENSION__: 'true' },
    // public/ is the PWA shell (sw.js, _headers, webmanifest, offline page);
    // the plugin copies only the icons the extension uses.
    publicDir: false,
    build: {
      outDir: 'dist-extension',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: here('index.html'),
          background: here('src/extension/background.ts'),
        },
        output: {
          // manifest.json names the worker, so its file name must be stable.
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        },
      },
    },
  }),
)
