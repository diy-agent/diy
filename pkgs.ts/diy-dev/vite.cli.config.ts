import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * CLI 构建配置
 *
 * 将 src/cli/index.ts 编译为 build/prod/cli/index.js，
 * 供 bin/dev 在生产环境加载（开发环境用 tsx 运行源码）。
 *
 * SSR 模式（node 环境）：vite 自动外部化 node 内建 + node_modules 依赖，
 * 只打包 TypeScript 源码到 JS。@diy/rpc 为 TS 源码依赖，由 Node 24+
 * 类型剥离直接运行（与 diy-app 同机制）。
 */
export default defineConfig({
  build: {
    outDir: "build/prod/cli",
    ssr: true,
    lib: {
      entry: resolve(__dirname, "src/cli/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    minify: false,
    sourcemap: false,
  },
});