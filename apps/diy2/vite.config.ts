import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 端口与代理**都不在这里**（##dev-app 构建对齐）：
// dev 是单端口 —— `server/dev.ts` 把 vite 以 middleware 挂进 diy2 自己的 HTTP server，
// UI 与 /api 同源。所以不存在「vite 端口」和「/api 代理目标」两处硬编码可写错，
// 也就不需要 `server.proxy`。端口 / 数据根 / 变体只有 `server/config.ts` 一处真源。
//
// 产物目录跟变体走：`build/<DIY2_VARIANT>/web`（缺省 prod）—— 变体只决定运行空间，
// 不是构建目标（lab / staging 与 prod 同一份代码）。
const variant = process.env['DIY2_VARIANT']?.trim() || 'prod';

export default defineConfig({
    plugins: [
        // React Compiler（React 19 的自动 memo 是**编译期**能力，默认不开）
        // v6 的原生入口走 oxc-transform-react；logDiagnostics 把"跳过优化"打出来
        react({ compiler: { target: '19', logDiagnostics: true } }),
        tailwindcss(),
    ],
    build: {
        // 和 server 产物同一个根：build/<variant>/{web,server}（全局命令 diy2 一起发）
        outDir: `build/${variant}/web`,
        emptyOutDir: true,
    },
});
