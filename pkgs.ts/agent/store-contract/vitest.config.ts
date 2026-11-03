import { defineConfig } from 'vitest/config';
// tests 里 `import ... from '@diy-agent/*'`：包 main 已指 lib/*.js，测试期指回 src
import { workspaceAliases } from '../../vitest.alias';

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // 首个失败即停（与 diy-app / 根配置同口径，见 ##255 R6③）
        bail: 1,
        // 本包的用例在**实现包**里跑（这里只有被 import 的函数），空跑不算失败
        passWithNoTests: true,
    },
});
