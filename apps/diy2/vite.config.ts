import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 端口与代理**都不在这里**（##dev-app 构建对齐）：
// dev 是单端口 —— `server/dev.ts` 把 vite 以 middleware 挂进 diy2 自己的 HTTP server，
// UI 与 /api 同源。所以不存在「vite 端口」和「/api 代理目标」两处硬编码可写错，
// 也就不需要 `server.proxy`。端口 / 数据根 / 变体只有 `server/config.ts` 一处真源。
//
// 产物目录**固定** `build/prod/web`（一个包目录一份产物）：变体目录已废 ——
// lab / staging 与生产跑的是同一份代码，差别只有数据根与端口（见 server/config.ts）。
// 多份并存靠 worktree（每个 worktree 有自己的 build/），不靠 `<variant>/` 子目录。

export default defineConfig({
    plugins: [
        // React Compiler（React 19 的自动 memo 是**编译期**能力，默认不开）
        // v6 的原生入口走 oxc-transform-react；logDiagnostics 把"跳过优化"打出来
        react({ compiler: { target: '19', logDiagnostics: true } }),
        tailwindcss(),
    ],
    build: {
        // 和 server / cli 产物同一个根：build/prod/{web,server,cli}（全局命令 diy2 一起发）
        outDir: 'build/prod/web',
        emptyOutDir: true,
        rollupOptions: {
            // 单页：主应用。workbench 的范例在它自己的包（pkgs.ts/ui/workbench-dock/examples），
            // 不再挂在这里 —— 框架的例子不该跟业务 app 一起发。
            input: {
                main: 'index.html',
            },
        },
    },
});
