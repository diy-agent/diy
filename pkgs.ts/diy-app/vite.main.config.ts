import { defineConfig } from "vite";
import { builtinModules } from "node:module";

const pkgDeps = ["@diy/rpc"];
const external = ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  build: {
    outDir: "out/main",
    lib: {
      entry: "src/main/index.ts",
      formats: ["es"],
      fileName: () => "index.mjs",
    },
    rollupOptions: {
      external: (id: string) =>
        pkgDeps.some((p) => id === p || id.startsWith(`${p}/`)) ? false
          : external.some((e) => id === e || id.startsWith(`${e}/`)) || !/^[./]/.test(id),
    },
    minify: false,
    emptyOutDir: true,
  },
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
});
