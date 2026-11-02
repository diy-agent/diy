import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../pkgs.ts/vitest.alias.js";

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
        bail: 1,
    },
});
