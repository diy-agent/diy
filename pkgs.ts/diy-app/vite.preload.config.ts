import { defineConfig } from "vite";
import { builtinModules } from "node:module";

const V = process.env.DIY_VARIANT ?? "prod"; // 变体产物根：prod|test|preview|lab
const pkgDeps = ["@diy/rpc", "@diy/template"];
const external = ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  build: {
    outDir: `build/${V}/preload`,
    lib: {
      entry: "src/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: (id: string) =>
        pkgDeps.some((p) => id === p || id.startsWith(`${p}/`)) ? false
          : external.some((e) => id === e || id.startsWith(`${e}/`)),
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
