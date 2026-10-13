import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { isAbsolute } from 'node:path'

// 同 vite.main.config.ts：Windows 解析结果是 'C:/…'，不能按裸 id 判成外部依赖
// （否则产物留 `import … from 'C:/…'` → ESM 加载抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const isAbsPath = (id: string) => isAbsolute(id) || /^[a-zA-Z]:[\\/]/.test(id)

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
          : external.some((e) => id === e || id.startsWith(`${e}/`)) ? true
            : isAbsPath(id) ? false
              : !/^[./]/.test(id),
    },
    minify: false,
    emptyOutDir: true,
  },
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
})
