import { defineConfig } from 'vitest/config';
// tests 里 `import { createRoom } from '@diy-agent/room'`：包 main 已指 lib/*.js，测试期指回 src
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
