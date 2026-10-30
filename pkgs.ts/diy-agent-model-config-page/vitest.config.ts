import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../vitest.alias.js";

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
        // 首个失败即停（与其它包同口径）
        bail: 1,
    },
});
