import { defineConfig } from "vite";
import { VARIANT as V, isExternal } from "./vite.pkg-deps";

// `pkgDeps` / `external` 判据 / 变体根都在 vite.pkg-deps.ts（main / serve / preload 共享真源，
// 新增 workspace 依赖必须同步加那里 —— 漏加 = 产物留 `import "@diy/x"`，node 加载 `.ts` 直接炸）。

export default defineConfig({
  build: {
    outDir: `build/${V}/main`,
    lib: {
      entry: "src/main/index.ts",
      formats: ["es"],
      fileName: () => "index.mjs",
    },
    rollupOptions: {
      external: (id: string) => isExternal(id),
    },
    minify: false,
    emptyOutDir: true,
  },
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
});
