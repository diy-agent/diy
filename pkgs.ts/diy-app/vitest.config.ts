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
    // E2E 重试一次：intent 测试是真实 Electron + CLI 往返，机器负载高时
    // 偶发假红（实测：两次全量各挂 1 例、且每次挂的是不同用例，单独跑都过）。
    // 轮询（tests/wait.ts）解决"慢一拍"，重试兜住剩下的时序噪声；
    // 真实 LLM 用例已改为显式 DIY_LLM_E2E=1 才跑，不在默认套件里。
    retry: 1,
    // 顺序执行（不并发）：intent 测试会各自拉起真实 Electron 实例并跑 CLI，
    // 并发时多实例抢 CPU 会让 probePort（1500ms）与用例断言双双超时；
    // 且各文件虽用独立临时 HOME，并发下仍会同时占用大量内存/端口，稳定性差。
    // 代价是总时长上升（并发 ~50s → 顺序 ~4min），换来确定性：值得。
    fileParallelism: false,
  },
});
