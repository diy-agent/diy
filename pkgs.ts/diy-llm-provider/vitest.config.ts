import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../vitest.alias.js';

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // 首个失败即停（与 diy-app / 根配置同口径，见 ##255 R6③）
        bail: 1,
    },
});
