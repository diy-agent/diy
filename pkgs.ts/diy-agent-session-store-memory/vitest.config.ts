import { defineConfig } from 'vitest/config';
// 测试期把 '@diy-agent/session' 指回 src（package main 指 lib/*.js，未 build 时解析不到实现）
import { workspaceAliases } from '../vitest.alias';

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // 首个失败即停（与 diy-app / 根配置同口径，见 ##255 R6③）
        bail: 1,
    },
});
