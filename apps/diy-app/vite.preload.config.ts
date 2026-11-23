import { defineConfig } from "vite";
import { BUILD_DIR, isExternal } from "./vite.pkg-deps";

// pkgDeps / external 判据 / 变体根 = vite.pkg-deps.ts（共享真源）

export default defineConfig({
  build: {
    outDir: `build/${BUILD_DIR}/preload`,
    lib: {
      entry: "src/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "index.js",
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
  esbuild: {
    drop: ["console", "debugger"],
  },
});
