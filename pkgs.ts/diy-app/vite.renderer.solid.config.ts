import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src/renderer_solid",
  base: "",
  build: {
    outDir: "../../out/renderer_solid",
    emptyOutDir: true,
  },
  plugins: [solid({ tsconfig: { compilerOptions: { jsx: "preserve", jsxImportSource: "solid-js" } } } as any), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer_solid"),
    },
  },
});
