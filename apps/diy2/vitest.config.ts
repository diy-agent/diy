import { defineConfig } from 'vitest/config';

// diy2 的单测：只测**纯函数**（配置裁决 / 端口裁决 / 注册表解析）。
// 起真实服务 / 真模型的验证不在这里 —— 那是 `./sha.sh lab` 之后的事（见 tests/README 无，README 有「验证」节）。
// 工作区包按 package.json 的 main 解析回 src（它们本来就是 TS 源，不需要 alias，##453 的 alias 只针对 lib/*.js 的那批）。
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
