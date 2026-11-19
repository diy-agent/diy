import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// CLI 产物：把 src/cli/index.ts（含 @diy-agent/rpc 与工作区包）打成单个 ESM 文件，
// 给 `bin/diy2` 转调。为什么不是 tsx 直跑源码：
//   · 发布形态只带 `bin/` + `build/prod/`，不能指望源码与 node_modules；
//   · 工作区包是 private，必须内联（与 vite.server.config.ts 同一条理由）。
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const variant = process.env['DIY2_VARIANT']?.trim() || 'prod';

export default defineConfig({
    build: {
        outDir: `build/${variant}/cli`,
        emptyOutDir: true,
        ssr: true,
        target: 'node22',
        minify: false,
        sourcemap: false,
        lib: {
            entry: 'src/cli/index.ts',
            formats: ['es'],
            fileName: () => 'index.mjs',
        },
        rollupOptions: {
            external: (id: string) => builtins.has(id) || id.startsWith('node:'),
            output: { entryFileNames: 'index.mjs', codeSplitting: false },
        },
    },
    ssr: { noExternal: true },
    resolve: { conditions: ['node'] },
});
