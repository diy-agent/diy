import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src/renderer_solid",
  base: "",
  build: {
    outDir: "../../out/renderer",
    emptyOutDir: true,
  },
  plugins: [solid({ tsconfig: { compilerOptions: { jsx: "preserve", jsxImportSource: "solid-js" } } } as any), tailwindcss()],
  // 预打包这几个真 CJS 包，否则 dev 模式白屏：
  // solid-markdown（含 "solid" 导出条件）被 vite-plugin-solid 排除出预打包，其 JSX 由本插件编译；
  // 但它引入的 remark-parse → unified / micromark 链条是真 ESM，由 dev server 按源码原样服务。
  // 该链条深处的 debug / extend 却是真 CJS（module.exports），原样服务时不会做 CJS→ESM interop，
  // 于是 `import createDebug from ".../debug/src/browser.js"` 在浏览器里报
  // "does not provide an export named 'default'" → renderer 直接白屏。
  // 依赖扫描器没能把它们纳入预打包（藏在被 exclude 的 solid 包的深层依赖里），故显式 include。
  optimizeDeps: {
    include: ["debug", "dequal", "extend"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer_solid"),
    },
  },
});
