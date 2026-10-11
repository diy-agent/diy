import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // intent 测试走真实 CLI/Electron 启动，单用例 2~4s 属正常；
    // 默认 5s 在全量并发抢 CPU 时不足 → 用例超时被掐断，afterAll 的
    // electron.stop() 来不及执行，测试 Electron 实例成为孤儿进程堆积。
    // 30s 仍不够：实测 `cli.intent.persona` 的「人物搜索」用例（多次 CLI 调用 + 面板交互）
    // 单独跑就要 ~20-25s，机器上有别的 worktree 同跑 intent 时（load 40+）突破 30s 被掐。
    // 放宽到 60s：去掉了 retry（见下），必须让「接近上限的长用例」有余量，否则负载一高就假红。
    // 仍是有界超时 —— 真死锁只多等一轮，bail:1 立刻停。
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
