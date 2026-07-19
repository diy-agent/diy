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
      external: [
        "node:fs",
        "node:path",
        "node:os",
        "node:events",
        "node:stream",
        "node:url",
        "node:child_process",
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
