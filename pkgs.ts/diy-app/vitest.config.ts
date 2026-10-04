import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // intent 测试走真实 CLI/Electron 启动，单用例 2~4s 属正常；
    // 默认 5s 在全量并发抢 CPU 时不足 → 用例超时被掐断，afterAll 的
    // electron.stop() 来不及执行，测试 Electron 实例成为孤儿进程堆积。
    // 放宽到 30s 保证 teardown 每次都走到（Teardown 泄露教训见 electron-test.ts stop）。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 不重试：重试会把「真问题」和「资源不够」一起掩盖成绿色，且失败用例再跑一遍让
    // 本就紧张的机器更挤（实测一条 10s 的用例 retry 后变 105s）。假红要显形，不要兜住。
    retry: 0,
    // 首个失败即停（含跨文件）：intent 测试是串行起真实 Electron，第一个红就是信号，
    // 继续跑只会让「到底是哪一处坏」更难看清。CI 与本地同此行为。
    bail: 1,
    // 顺序执行（不并发）：intent 测试会各自拉起真实 Electron 实例并跑 CLI，
    // 并发时多实例抢 CPU 会让 probePort（1500ms）与用例断言双双超时；
    // 且各文件虽用独立临时 HOME，并发下仍会同时占用大量内存/端口，稳定性差。
    // 代价是总时长上升（并发 ~50s → 顺序 ~4min），换来确定性：值得。
    fileParallelism: false,
  },
});
