import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../pkgs.ts/vitest.alias.js';

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        bail: 1,
        // 真起端口 / 真跑 WS：默认 5s 不够（首个会话要读 model.yaml）
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
