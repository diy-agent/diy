// tests/cli.intent.env-net.test.ts
// ═══════════════════════════════════════════════════════════════
// ##384「环境感知」的**活体网络路径** —— 真的连不上、真的恢复。
//
// 为什么单独一个文件：本用例要让实例**真的**经历网络层失败，而 `DIY_ZEN_BASE_URL`
// 是启动期注入的环境变量（`resolveBaseUrl` 在 main 里读 process.env）—— 它会污染同文件里
// 别的用例（那些要正常上游），所以隔离成独立文件、独立实例。
//
// 探针设计（用户口径：**不要真拔网卡**，那会把本机所有实例一起搞断）：
//   · 失败态：先 listen 拿一个空闲端口，再 close —— 之后连它就是 ECONNREFUSED（确定、秒回）
//   · 恢复态：在**同一端口**起桩上游（回合法 SSE）→ 下一轮成功 → bar 自动消
// 全程只打本机 127.0.0.1，不碰外网、不碰 DNS 配置。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let stub: Server | null = null;
let baseUrl = "";
let uri = "";

/** 拿一个此刻空闲的端口（listen 后立刻 close）：之后连它就是 ECONNREFUSED */
async function pickClosedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** 桩上游：一段合法 SSE（chat 面），让"这一轮成功"成为确定事实 */
function startStub(port: number): Promise<Server> {
  const s = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "stub",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mimo-v2.6-flash",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ content: "好" }, null));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((r) => s.listen(port, "127.0.0.1", () => r(s)));
}

const netBar = () =>
  fx.sh.run("./diy.sh env ls").then((r) => r.stdout);

beforeAll(async () => {
  const port = await pickClosedPort();
  baseUrl = `http://127.0.0.1:${port}/v1`;
  process.env["OPENCODE_API_KEY"] ||= "intent-test-dummy-key";
  process.env["DIY_ZEN_BASE_URL"] = baseUrl;
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/env-net --label EnvNet`);
  // project/task create 的输出是 `{ status, data: { id } }`（StatusDataUri），getJson 已剥掉最外层 `{ok,data}`
  const pid = String((p as any)?.data?.data?.id ?? "");
  const t = await fx.sh.getJson(`./diy.sh task create "环境感知网络路径" ${pid}`);
  uri = String((t as any)?.data?.data?.uri ?? "");
  // 桩端口留给"恢复"阶段
  (fx as unknown as { port: number }).port = port;
}, 120_000);

afterAll(async () => {
  if (stub) await new Promise<void>((r) => stub!.close(() => r()));
  await fx?.electron?.stop();
  delete process.env["DIY_ZEN_BASE_URL"];
});

describe("##384 网络不可达 → 顶栏红条（真连不上 / 真恢复）", () => {
  it("连续 3 轮连不上 → network-down 出现，带连败次数与错误码", async () => {
    // 每轮的 stderr 留着：bar 没亮时**必须**能看到"究竟失败成什么样"（否则排查只能靠猜）
    const rounds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fx.sh.run(`./diy.sh agent local chat ${uri} "第 ${i + 1} 次" --model mimo-v2.6-flash`, 60_000);
      rounds.push(`[第 ${i + 1} 轮 exit=${r.code}] ${(r.stderr || r.stdout || "").slice(-600)}`);
    }
    const text = await waitUntil(netBar, (s) => s.includes("network-down"), {
      label: `network-down 出现在 env ls（三轮现场：\n${rounds.join("\n")}）`,
      timeoutMs: 15_000,
    });
    expect(text).toContain("network-down");
    expect(text).toContain("连续");
    // 错误码：连本机关闭的端口 = ECONNREFUSED（连接被拒，属网络层错误族）
    expect(text).toMatch(/ECONNREFUSED|ECONNRESET/);
  }, 120_000);

  it("上游恢复 → 下一轮成功即自动消（不要用户手动关）", async () => {
    stub = await startStub((fx as unknown as { port: number }).port);
    await fx.sh.run(`./diy.sh agent local chat ${uri} "恢复了吗" --model mimo-v2.6-flash`, 60_000);
    const text = await waitUntil(netBar, (s) => !s.includes("network-down"), {
      label: "network-down 自动消",
      timeoutMs: 15_000,
    });
    expect(text).not.toContain("network-down");
  }, 120_000);
});
