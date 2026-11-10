import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.alias.js";

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    esbuild: { jsx: "automatic", jsxImportSource: "react" },
    test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], environment: "happy-dom", globals: true },
});
