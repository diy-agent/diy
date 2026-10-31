import { defineConfig } from 'vitest/config';

// 注意（##453）：各包 package.json 的 main/exports 已指 lib/*.js（Electron 用 Node 直接加载），
// 单测必须解析回 src —— 故 alias 配在**各 project 自己的 config** 里（projects 模式下根
// resolve 不下发）：真源 `pkgs.ts/vitest.alias.ts`，diy-app / diy-flow 两个 config 已接。
export default defineConfig({
  test: {
    projects: [
        'pkgs.ts/diy-log',
        'pkgs.ts/diy-app',
        'pkgs.ts/diy-rpc',
        'pkgs.ts/diy-remote',
        'pkgs.ts/diy-template',
        'pkgs.ts/diy-talk',
        'pkgs.ts/diy-dev',
        'pkgs.ts/diy-flow',
        'pkgs.ts/diy-agent-session',
        'pkgs.ts/diy-agent-session-store-jsonl',
        'pkgs.ts/diy-room',
    ],
    // diy-app 的 cli.intent 是真实 Electron + http2 集成测试，diy-rpc 的
    // transport-raw/http-raw 也做真实 IO；两个 project 并发跑时 setTimeout/
    // setImmediate 时序被挤兑会偶发挂起/超时。maxWorkers:1 强制全串行（跨 project
    // 也不并发），保证确定性——实测并发跑偶发 20-26 用例失败，串行稳定全绿。
    maxWorkers: 1,
    fileParallelism: false,
    // 首个失败即停：intent 是大头（串行起真实 Electron），红一条就没必要把剩下的跑完
    bail: 1,
  },
});
