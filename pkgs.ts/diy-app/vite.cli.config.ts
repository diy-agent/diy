import { defineConfig } from "vite";
import { resolve } from "node:path";

/** CLI 构建配置
 *
 * 将 src/cli/index.ts 编译为 out/cli/index.js，
 * 供 bin/diy2.mjs 在生产环境加载（开发环境用 tsx 运行源码）。
 *
 * 外部化所有运行时依赖（它们在 node_modules 里），
 * 只打包 TypeScript 源码到 JS。
 */
export default defineConfig({
  build: {
    outDir: "out/cli",
    lib: {
      entry: resolve(__dirname, "src/cli/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      // 外部化所有 node 内建模块（保持原生 import，避免 vite 替换成 __vite-browser-external
      // 空 shim——CLI 经 @diy/rpc/http 依赖 node:http2，缺这个会运行时报
      // `__vite_browser_external.connect is not a function`）。
      external: [
        /^node:/,
        "zod",
        "fastify",
        "@fastify/cors",
        "@fastify/http-proxy",
        "chokidar",
        "js-yaml",
      ],
    },
    minify: false,
    sourcemap: false,
  },
});
