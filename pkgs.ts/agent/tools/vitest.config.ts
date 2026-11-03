import { defineConfig } from "vitest/config";
// workspace 能力包在测试期指回 src（##453 方案 B：包 main 已指 lib/*.js，运行读 lib、单测读 src）
// 本包 src/shell/result.ts 用了 `@diy-agent/context/schema/schema-doc`（结果头的字段说明），
// 而 context 的 lib/ 不一定构建过 ⇒ 测试期必须按源码解析（同 apps/diy-app 的做法）。
import { workspaceAliases } from "../../vitest.alias";

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
