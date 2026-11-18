// examples 的 vite 配置 —— 例子自成一个前端工程，不依赖任何 app（apps/diy2 里不再有 dock 入口）。
//
// 跑：
//   ./sha.sh dev        等价 `npx vite`（root = examples/），访问打印出的地址
//   ./sha.sh dev 02     只开 02-pages（`npx vite --open /02-pages/`）
//
// 为什么不用 @vitejs/plugin-react：它只带来 Fast Refresh + React Compiler。例子要的是
// 「改完刷新就看见」，vite 内置的 esbuild 已经按 automatic runtime 转 JSX。少一个依赖，
// 例子就不需要跟着 diy2 的 plugin 版本走。真需要 HMR 时再加不迟。
import { defineConfig } from 'vite';

// root = 当前目录（不写 root）：这条命令就在 examples/ 里跑，见包的 sha.sh::dev
export default defineConfig({
    // 每个例子一个 html：能独立打开，也能从 index.html 串起来看。
    // 加一个例子 = 这里加一行 + index.html 加一张卡片 + README 表格加一行。
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                index: 'index.html',
                basic: '01-basic/index.html',
                pages: '02-pages/index.html',
                plugin: '03-plugin/index.html',
                vanilla: '04-vanilla/index.html',
            },
        },
    },
    server: { open: '/index.html' },
});
