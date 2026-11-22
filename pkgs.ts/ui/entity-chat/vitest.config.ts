import { defineConfig } from 'vitest/config';
// RPC 切完（##6xx）后测试路径必经 agent/protocol → @diy-agent/rpc，
// 而包的 exports 指 lib/*.js；不接 alias 会在加载期解析失败（5/10 文件起不来）。
import { workspaceAliases } from '../../vitest.alias.js';

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    },
});
