import { defineConfig } from 'vitest/config';
// 单测里要拿 `@diy-agent/remote` 的纯实现跟本壳的副本对拍（tests/address.test.ts）：
// 测试期指回 src（##453 方案 B），运行期本壳仍与那个包无耦合。
import { workspaceAliases } from '../../pkgs.ts/vitest.alias.js';

export default defineConfig({
    resolve: { alias: [...workspaceAliases] },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        bail: 1,
    },
});
