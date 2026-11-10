import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../vitest.alias.js';

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    // 意图测试里有 .tsx（React 组件 + @testing-library）：走 automatic runtime
    esbuild: { jsx: "automatic", jsxImportSource: "react" },
    test: {
        // .tsx 也要收：UI 意图测试是 .tsx（docs/ui-architecture.md §5.4 的构建链注意事项）
        include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
        environment: 'node',
        bail: 1,
    },
});
