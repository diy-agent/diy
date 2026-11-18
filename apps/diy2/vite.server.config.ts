import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// 服务端产物：把 server/index.ts（含 @diy-agent/* 工作区包）打成单个 ESM 文件，
// 给 `bin/diy2` 用。node: 内建保持 external，其余依赖一律打进来 ——
// 工作区包都是 private，发布时不作为 dependency 存在，留着 import 就装不起来。
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

// 产物目录跟变体走（与 vite.config.ts 同一条规则）：`build/<DIY2_VARIANT>/server`
const variant = process.env['DIY2_VARIANT']?.trim() || 'prod';

export default defineConfig({
    build: {
        outDir: `build/${variant}/server`,
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
            // 单文件产物：bin/diy2 只认 build/<variant>/server/index.mjs。
            // 依赖内部有动态 import（token 工具等），不关掉代码分割就会在旁边多出几个 chunk 文件
            // —— 发布形态的 `files` 只带整个 build/prod/，技术上也能跑，但「一个入口文件」更省心。
            output: { entryFileNames: 'index.mjs', codeSplitting: false },
        },
    },
    // 第三方依赖也打进来：发布形态里只留 bin/ + build/prod/，运行时不需要 npm install
    // （工作区包是 private，本来也只能内联）
    ssr: { noExternal: true },
    resolve: {
        conditions: ['node'],
    },
});
