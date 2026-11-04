import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { builtinModules } from "node:module";

const V = process.env.DIY_VARIANT ?? "prod"; // 变体产物根：prod|test|lab

/**
 * 浏览器安全护栏：**renderer 产物里不许出现 `node:` 内置模块**。
 *
 * 为什么要有（2026-11-04 黑屏事故）：`shared/run-view` 是 renderer 用的纯呈现层，
 * 它从 `shared/run-status` 取几个格式化函数；那次 `shared/run-status` 图省事写了
 * `export * from "@diy-agent/jobs"`（包入口 barrel），于是连带拉进 `run-registry`
 * → `@diy-agent/tools/shell/run` → `node:child_process`，而后者**模块顶层**就读
 * `process.platform` / `process.kill`。浏览器（nodeIntegration=false）里没有 `process`
 * ⇒ 整份 bundle 在求值阶段抛 `ReferenceError`，窗口纯黑、UI 一行都不渲染。
 *
 * 为什么不是"运行时兜底"：这类错误发生在**任何一个模块求值**时，先于任何组件，
 * 事后无从降级；只能在构建期拦。判据故意用 `node:` 前缀（最稳的一条）——
 * 真正的宿主能力都从 node 内置进来，纯 `process` 引用迟早伴随其一。
 */
function browserSafe(): Plugin {
  return {
    name: "diy:renderer-browser-safe",
    // 必须在 vite:resolve 之前拦：Vite 对内置模块的处理是「externalize + 打一行 warning」，
    // 构建照样成功、产物里也看不出痕迹（实测 externalized 后的 stub 会被摇掉）——
    // 光靠事后扫产物抓不到，只有 resolve 这一刻知道「谁 import 了 node 内置」。
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer) return null; // 构建器自己的探测（无 importer）不算
      const isBuiltin = source.startsWith("node:") || builtinModules.includes(source);
      if (!isBuiltin) return null;
      this.error(
        [
          `renderer 图里出现了 node 内置依赖：${importer} → ${source}`,
          "浏览器里没有它（nodeIntegration=false），模块求值即抛 → 整份 bundle 失败、窗口纯黑。",
          "修法：renderer 能碰到的模块（src/renderer_solid、src/shared）只许走**浏览器安全的窄入口**，",
          "别 import 会带出宿主能力（node:child_process / node:fs …）的包入口或 barrel。",
        ].join("\n"),
      );
    },
  };
}

export default defineConfig({
  root: "src/renderer_solid",
  base: "",
  build: {
    outDir: `../../build/${V}/renderer`,
    emptyOutDir: true,
  },
  plugins: [solid({ tsconfig: { compilerOptions: { jsx: "preserve", jsxImportSource: "solid-js" } } } as any), tailwindcss(), browserSafe()],
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
