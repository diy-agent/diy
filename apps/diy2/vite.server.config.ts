import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// 服务端产物：把 server/index.ts（含 @diy-agent/* 工作区包）打成单个 ESM 文件，
// 给 `bin/diy2` 用。node: 内建保持 external，其余依赖一律打进来 ——
// 工作区包都是 private，发布时不作为 dependency 存在，留着 import 就装不起来。
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export default defineConfig({
    build: {
        outDir: 'build/prod/server',
        emptyOutDir: true,
        ssr: true,
        target: 'node22',
        minify: false,
        sourcemap: true,
        lib: {
            entry: 'server/index.ts',
            formats: ['es'],
            fileName: () => 'index.mjs',
        },
        rollupOptions: {
            external: (id: string) => builtins.has(id) || id.startsWith('node:'),
            output: { entryFileNames: 'index.mjs' },
        },
    },
    // 第三方依赖也打进来：发布形态里只留 bin/ + build/prod/，运行时不需要 npm install
    // （工作区包是 private，本来也只能内联）
    ssr: { noExternal: true },
    resolve: {
        conditions: ['node'],
    },
});
