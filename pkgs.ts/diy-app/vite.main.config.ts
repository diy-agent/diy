import { defineConfig } from "vite";
import { builtinModules } from "node:module";
import { isAbsolute } from "node:path";

// rollup 会用裸 id（"@diy/rpc/electron"）和 resolve 后的绝对路径各调一次 external。
// Windows 上解析结果是 "C:/…"，既不以 "./" 也不以 "/" 开头 —— 按「裸 id」判会误判成外部依赖，
// 产物里留下 `import … from "C:/…"`，ESM 加载抛 ERR_UNSUPPORTED_ESM_URL_SCHEME。
// 判据：绝对路径 = 已解析的本地源码，必须打包进来。
const isAbsPath = (id: string) => isAbsolute(id) || /^[a-zA-Z]:[\\/]/.test(id);

const V = process.env.DIY_VARIANT ?? "prod"; // 变体产物根：prod|test|preview|lab
// pkgDeps = 要**打包进来**的 workspace 包（它们是 TS 源码，external 化 = 产物里留 `import "@diy/x"`
// → node 加载 `.ts` 直接炸）。新增 workspace 依赖必须同步加这里。
const pkgDeps = ["@diy/rpc", "@diy/template", "@diy/flow", "@diy/talk"];
const external = ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  build: {
    outDir: `build/${V}/main`,
    lib: {
      entry: "src/main/index.ts",
      formats: ["es"],
      fileName: () => "index.mjs",
    },
    rollupOptions: {
      external: (id: string) =>
        pkgDeps.some((p) => id === p || id.startsWith(`${p}/`)) ? false
          : external.some((e) => id === e || id.startsWith(`${e}/`)) ? true
            : isAbsPath(id) ? false
              : !/^[./]/.test(id),
    },
    minify: false,
    emptyOutDir: true,
  },
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
});
