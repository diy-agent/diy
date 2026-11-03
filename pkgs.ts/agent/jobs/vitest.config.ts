import { defineConfig } from "vitest/config";
// workspace 能力包在测试期指回 src（##453 方案 B：包 main 已指 lib/*.js，运行读 lib、单测读 src）
import { workspaceAliases } from "../../vitest.alias";

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
        // 本包的用例真起进程（`sh -c 'sleep …'`）：默认 5s 会在慢机器上假红
        testTimeout: 20_000,
    },
});
