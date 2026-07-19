import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'

const pkgDeps = ['@diy/rpc', '@diy/rpc-transport']
const external = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

export default defineConfig({
  build: {
    outDir: 'out/serve',
    lib: {
      entry: 'src/serve/index.ts',
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: (id: string) =>
        pkgDeps.includes(id) ? false
          : external.some((e) => id === e || id.startsWith(`${e}/`)) || !/^[./]/.test(id),
    },
    minify: false,
    emptyOutDir: true,
  },
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
})
