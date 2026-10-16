// tests/cli.intent.instance-identity.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 实例身份靠**自报**，不靠端口（##328）
//
// 事故原文：生产（`~/.diy`）与 worktree dev（`build/<variant>/home`）都兜底 18888。
// 生产实例没在跑时，一条全局 `diy` 命令探到 18888 上有 HTTP 响应就复用 → 连到了 dev 实例上，
// 两边数据根不同却串台。根因不是某个端口写错，而是 **CLI 复用前从不问对方是谁**。
//
// 契约（本文件锁死）：
//   1. 同数据根的实例照常复用（校验不能把正常复用一起锁死）
//   2. `app.port` 记的端口上站着**别的数据根**的实例 → 拒绝复用（串台即失败）
//   3. 两个数据根各自的实例并存时，各自的 CLI 打到各自的实例
//   4. 服务端 `/cli` 拒绝别的数据根（http 快路径自身不校验，全靠这道 409）
//   5. 不带 home 的旧调用仍放行（兼容分支别失守）
//
// 判据是活体自报（`diy.getAppInfo.diyHome`）：`app.port` 里的端口可能陈旧，
// 端口上现在住着谁只有那个进程答得准。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

let instA: ElectronTest;
let instB: ElectronTest;
const shells: ShellTest[] = [];
/** 本文件自己造的（空）数据根：测完即删 —— 它们不是 startElectronTest 的隔离 HOME */
const scratchHomes: string[] = [];

function shellFor(home: string): ShellTest {
  // cwd = 仓库根：`./diy.sh` 是 worktree 通用 CLI 客户端，连谁由 DIY_HOME 决定
  const sh = new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME: home, DIY_HOME: home } });
  shells.push(sh);
  return sh;
}

function scratchHome(): string {
  const h = mkdtempSync(join(tmpdir(), "diy-identity-scratch-"));
  scratchHomes.push(h);
  return h;
}

/** 跑一条 CLI 并取 JSON 输出的 data 段（失败时把 stderr 一起带出来，便于定位） */
async function getAppInfo(sh: ShellTest): Promise<{ diyHome: string; pid: number; port: number }> {
  const r = await sh.run("./diy.sh getAppInfo --json", 20000);
  if (r.code !== 0) throw new Error(`getAppInfo 失败 exit=${r.code}\nstderr: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { data: { diyHome: string; pid: number; port: number } }).data;
}

/**
 * 直接向实例端口发 `POST /cli`（绕开 `diy.sh`）。
 * 服务端 409 是「http 快路径不串台」的唯一闸门 —— `diy.sh` 自己不做身份校验，全靠它拒。
 */
function postCli(
  port: number,
  body: unknown,
): Promise<{ status: number; body: string; hasExitHeader: boolean }> {
  return new Promise((resolve, reject) => {
    const client = connect(`http://127.0.0.1:${port}`);
    client.on("error", reject);
    const req = client.request({
      ":method": "POST",
      ":path": "/cli",
      "content-type": "application/json",
    });
    let status = 0;
    let hasExitHeader = false;
    req.on("response", (headers) => {
      status = Number(headers[":status"]);
      // x-diy-exit 存在 = 请求被当成本实例的命令执行了（diy.sh 靠它判断是否回退直连）
      hasExitHeader = headers["x-diy-exit"] !== undefined;
    });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      client.close();
      resolve({ status, body: Buffer.concat(chunks).toString("utf8"), hasExitHeader });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

beforeAll(async () => {
  instA = await startElectronTest();
  instB = await startElectronTest();
}, 120000);

afterAll(async () => {
  for (const sh of shells) sh.close();
  await instA?.stop();
  await instB?.stop();
  for (const h of scratchHomes) {
    try { rmSync(h, { recursive: true, force: true }); } catch { /* 已删 */ }
  }
});

describe("实例身份校验（##328）", () => {
  it("同数据根 → 照常复用（校验不误杀正常路径）", async () => {
    const info = await getAppInfo(shellFor(instA.home));
    expect(info.diyHome).toBe(instA.home);
    expect(info.port).toBe(instA.port);
  });

  it("两个数据根的实例并存 → 各打各的，互不串台", async () => {
    const a = await getAppInfo(shellFor(instA.home));
    const b = await getAppInfo(shellFor(instB.home));
    expect(a.diyHome).toBe(instA.home);
    expect(b.diyHome).toBe(instB.home);
    expect(a.pid).not.toBe(b.pid);
  });

  it("app.port 指向别人的实例 → 拒绝复用（旧行为会连上去，那就是串台）", async () => {
    // A 自报的 pid（`ElectronTest` 只暴露 home/port，进程 pid 从实例自己问最可靠）
    const a = await getAppInfo(shellFor(instA.home));

    // 造「陈旧 app.port」处境：一个没有实例的数据根，端口却记着 A 的端口。
    // 这正是生产没在跑、dev 占着 18888 时的现场。
    const home = scratchHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "app.port"), String(instA.port), "utf-8");

    const sh = shellFor(home);
    const r = await sh.run("./diy.sh getAppInfo --json", 20000);

    // 测试环境 DIY_NO_LAUNCH=1：拒绝复用后不许悄悄拉起新实例，而是报「未就绪」
    expect(r.code).not.toBe(0);
    // 关键断言：**没有**把 A 的实例当成自己的（数据根与进程都不是 A）
    expect(r.stdout).not.toContain(instA.home);
    expect(r.stdout).not.toContain(String(a.pid));
    // 且要给得出「端口上是谁」的解释（stderr，不污染 stdout 的 JSON）
    expect(r.stderr).toContain("另一个实例");
  });

  // ── 服务端防线（##266 review R1）──────────────────────────────
  // `diy.sh` 的 http 快路径**自身不校验身份**，全靠服务端这个 409 拒。
  // 上面第三条测的是「拒绝复用后的 CLI 行为」，这里直接锁服务端这一层。

  it("/cli 带别的数据根的 home → 409 home-mismatch（快路径不串台的唯一闸门）", async () => {
    const r = await postCli(instA.port, {
      argv: ["getAppInfo", "--json"],
      cwd: process.cwd(),
      home: instB.home,
    });
    expect(r.status).toBe(409);
    const body = JSON.parse(r.body) as { error: string; serverHome: string; clientHome: string };
    expect(body.error).toBe("home-mismatch");
    // 双方数据根都回给调用方（便于人定位「我的 app.port 陈旧到了谁那里」）
    expect(body.serverHome).toBe(instA.home);
    expect(body.clientHome).toBe(instB.home);
    // 没有 x-diy-exit → diy.sh 判定「对端没执行」→ 回退直连 CLI
    expect(r.hasExitHeader).toBe(false);
  });

  it("兼容分支：/cli 不带 home 的旧调用照常执行（别让兼容路径失守）", async () => {
    const r = await postCli(instA.port, {
      argv: ["getAppInfo", "--json"],
      cwd: process.cwd(),
    });
    expect(r.status).toBe(200);
    expect(r.hasExitHeader).toBe(true);
    const info = (JSON.parse(r.body) as { data: { diyHome: string } }).data;
    expect(info.diyHome).toBe(instA.home);
  });
});
