import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../pkgs.ts/vitest.alias.js";

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        // e2e 要起 Electron，默认不跑（DIY_E2E=1 才跑，见 npm run test:e2e）
        include: ["tests/**/*.test.ts"],
        exclude: process.env["DIY_E2E"] ? ["**/node_modules/**"] : ["tests/e2e/**", "**/node_modules/**"],
        environment: "node",
        bail: 1,
    },
});
