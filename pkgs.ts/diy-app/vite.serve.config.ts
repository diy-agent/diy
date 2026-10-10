import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'

const pkgDeps = ['@diy/rpc', '@diy/template']
const external = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

const V = process.env.DIY_VARIANT ?? "prod"; // 变体产物根：prod|test|preview|lab

export default defineConfig({
  build: {
    outDir: `build/${V}/serve`,
    lib: {
      entry: 'src/serve/index.ts',
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: (id: string) =>
        pkgDeps.some((p) => id === p || id.startsWith(`${p}/`)) ? false
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
