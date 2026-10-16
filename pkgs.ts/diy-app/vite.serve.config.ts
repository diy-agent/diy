import { defineConfig } from 'vite'
import { VARIANT as V, isExternal } from './vite.pkg-deps'

// pkgDeps / external 判据 / 变体根 = vite.pkg-deps.ts（共享真源；serve 与 main 曾各写一份，
// 于是加 @diy/flow 时漏了 serve —— 见 ##319 review1 P2-A）。

export default defineConfig({
  build: {
    outDir: `build/${V}/serve`,
    lib: {
      entry: 'src/serve/index.ts',
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: (id: string) => isExternal(id),
    },
    minify: false,
    emptyOutDir: true,
  },
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
})
