import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        // 本地 repo 构建的 git 测试互相独立，串行保证确定性
        maxWorkers: 1,
        fileParallelism: false,
        // 首个失败即停（与 diy-app / 根配置同口径，见 ##255 R6③）
        bail: 1,
    },
});