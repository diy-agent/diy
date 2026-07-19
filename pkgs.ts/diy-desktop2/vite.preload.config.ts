import { defineConfig } from "vite";
import { builtinModules } from "node:module";

const pkgDeps = ["@diy/rpc", "@diy/rpc-transport-electron", "@diy/rpc-transport"];
const external = ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  build: {
    outDir: "out/preload",
    lib: {
      entry: "src/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: (id: string) =>
        pkgDeps.includes(id) ? false
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
