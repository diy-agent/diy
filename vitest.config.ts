import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['pkgs.ts/diy-app', 'pkgs.ts/diy-rpc'],
    // diy-app 的 cli.intent 是真实 Electron + http2 集成测试，diy-rpc 的
    // transport-raw/http-raw 也做真实 IO；两个 project 并发跑时 setTimeout/
    // setImmediate 时序被挤兑会偶发挂起/超时。maxWorkers:1 强制全串行（跨 project
    // 也不并发），保证确定性——实测并发跑偶发 20-26 用例失败，串行稳定全绿。
    maxWorkers: 1,
    fileParallelism: false,
  },
});
