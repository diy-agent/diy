// tests/cli.intent.compact-plan.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 plan 版本化（##378 M3b）—— CLI/真实实例的端到端意图
//
// 需求：plan（`history.keep[]`）每次变化都**入版本链**（内容寻址 CAS + index.jsonl）；
//   压缩事件账只记 `planVersion` 指针（**不再内嵌全文**）；回滚按**版本 id**（也兼容旧快照 id）。
//
// 本文件只验「三面里的 CLI 一面 + 落盘形态」（工具面与 UI 面另在单测/UI 意图里）：
//   ① `compact plan versions` 列表：当前版本 = 链尾；set 之后多一行
//   ② `compact plan version <id>`：能取回该版全文（内容 = 纯 plan 数据）
//   ③ `compact plan restore <id>`：按**版本 id** 切指针（不是「最近一份快照」）
//   ④ `compact run` 后事件里是 `plan.planVersion`，**没有** `plan.keep` 全文；CAS 里能取回
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { keyOf } from "../src/main/core/local-paths";

const REPO_ROOT = join(__dirname, "..", "..", "..");

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };

beforeAll(async () => {
  const electron = await startElectronTest();
  fx = {
    electron,
    HOME: electron.home,
    sh: new ShellTest({ cwd: REPO_ROOT, env: { HOME: electron.home, DIY_HOME: electron.home } }),
  };
}, 120_000);

afterAll(async () => {
  fx?.sh?.close();
  await fx?.electron?.stop();
});

/** 建项目 + 任务，返回 taskUri */
async function newTask(title: string): Promise<string> {
  const p = await fx.sh.getJson(`./diy.sh project create ${join(fx.HOME, `t-${Date.now()}`)}`);
  const pid = String((p.data as { data?: { id?: string } })?.data?.id);
  const t = await fx.sh.getJson(`./diy.sh task create ${JSON.stringify(title)} ${pid}`);
  return String(((t.data as Record<string, unknown>)?.data as Record<string, unknown>)?.uri ?? "");
}

/** RPC 单发返回的是**裸结果**（`{ok,data}` 那层由 CLI 的 --json 包在外面 ⇒ `r.data` 即结果） */
type VersionsModel = {
  current: string;
  versions: { version: string; op: string; parent: string | null; brief: string }[];
};
const planVersions = (uri: string) =>
  fx.sh
    .getJson(`./diy.sh agent local compact plan versions ${uri}`)
    .then((r) => r.data as unknown as VersionsModel);

const planGet = (uri: string) =>
  fx.sh
    .getJson(`./diy.sh agent local compact plan get ${uri}`)
    .then((r) => r.data as unknown as { keep: { type: string }[]; version: string });

/** 把级列表写成一个文件（`plan set` 的第二个位置参数是**文件路径**） */
function keepFile(name: string, keep: unknown): string {
  const dir = join(fx.HOME, "keep-fixtures");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}.json`);
  writeFileSync(f, JSON.stringify(keep), "utf-8");
  return f;
}

const KEEP_A = [{ type: "steps", must: true, clip: { type: "full" }, data: { n: 6 } }, { type: "ladder" }];
const KEEP_B = [{ type: "recent", data: { n: 3 } }];
/** 只保 1 步（must）：压缩时**真的会丢轮** ⇒ 非空操作、才写账（预算 0 下留 must 这一档） */
const KEEP_C = [{ type: "steps", must: true, clip: { type: "full" }, data: { n: 1 } }];

/** 实例的会话落盘（⚠️ 必须拼 `fx.HOME` —— 测试进程自己的 `DIY_HOME` 与 Electron 实例的**不是同一个**） */
const localFile = (uri: string, ext: string) => join(fx.HOME, "local", `${keyOf(uri)}${ext}`);
const opsPath = (uri: string) => localFile(uri, ".ops.jsonl");
const compactFile = (uri: string) => localFile(uri, ".compact.jsonl");

describe("plan 版本链（CLI 面）", () => {
  it("set 入链 → versions 列表能列出来、current = 链尾；version <id> 取回纯 plan 数据", async () => {
    const uri = await newTask("plan 版本链");
    // 初始：链为空，但 current 已能给出版本 id（由生效内容现算）
    const v0 = await planVersions(uri);
    expect(v0.versions).toHaveLength(0);
    expect(v0.current).toMatch(/^plan-[0-9a-f]{12}$/);

    await fx.sh.getJson(`./diy.sh agent local compact plan set ${uri} ${keepFile("a", KEEP_A)}`);
    const v1 = await planVersions(uri);
    expect(v1.versions).toHaveLength(1);
    expect(v1.versions[0]!.op).toBe("set");
    expect(v1.versions[0]!.parent).toBeNull();
    expect(v1.versions[0]!.brief.length).toBeGreaterThan(0);
    expect(v1.current).toBe(v1.versions[0]!.version);
    expect((await planGet(uri)).version).toBe(v1.current);

    // 单版详情：全文 + 版本号（内容 = 纯 plan 数据，不含 ts/op 这类元信息）
    const one = (await fx.sh.getJson(`./diy.sh agent local compact plan version ${uri} ${v1.current}`)).data as unknown as {
      doc: { v: number; source: string; keep: { type: string }[]; ts?: string; op?: string };
    };
    expect(Object.keys(one.doc).sort()).toEqual(["keep", "source", "v"]);
    expect(one.doc.keep.map((k) => k.type)).toEqual(["steps", "ladder"]);
    expect(one.doc.source).toBe("config");

    // CAS 落盘：全局一份（跨会话去重）
    expect(existsSync(join(fx.HOME, "plan-store", `${v1.current}.json`))).toBe(true);
    // 链落盘：local/plan/<scopeKey>/index.jsonl
    const chainDir = join(fx.HOME, "local", "plan");
    const scopeKeys = readdirSync(chainDir);
    expect(scopeKeys).toHaveLength(1); // 全局作用域 = 一份链（不是每任务一份）
    expect(scopeKeys[0]).toMatch(/^plan-scope_global-[0-9a-f]{12}$/);
    expect(readFileSync(join(chainDir, scopeKeys[0]!, "index.jsonl"), "utf-8")).toContain(v1.current);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("restore 按**版本 id** 切指针（parent 成链；回滚本身也入链）", async () => {
    const uri = await newTask("plan 回滚按版本");
    await fx.sh.getJson(`./diy.sh agent local compact plan set ${uri} ${keepFile("a2", KEEP_A)}`);
    const a = (await planVersions(uri)).versions[0]!.version;
    await fx.sh.getJson(`./diy.sh agent local compact plan set ${uri} ${keepFile("b2", KEEP_B)}`);
    expect((await planGet(uri)).keep.map((k) => k.type)).toEqual(["recent"]);

    // 明确回到 A 版（若按「最近一份快照」也恰好是 A，但这里走的是版本 id 这条路）
    const rb = (await fx.sh.getJson(`./diy.sh agent local compact plan restore ${uri} ${a}`)).data as unknown as {
      written: boolean;
      planVersion: string;
    };
    expect(rb.written).toBe(true);
    expect(rb.planVersion).toBe(a);
    expect((await planGet(uri)).keep.map((k) => k.type)).toEqual(["steps", "ladder"]);

    const rows = (await planVersions(uri)).versions;
    expect(rows.map((r) => r.op)).toEqual(["set", "set", "restore"]);
    expect(rows[2]!.version).toBe(a);
    expect(rows[2]!.parent).toBe(rows[1]!.version);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("压缩事件只记 `planVersion`（**不含 keep 全文**），且指针可回查 CAS", async () => {
    const uri = await newTask("压缩只记版本");
    // 种三轮会话（压缩要有东西可压，否则是空操作、不写账）
    const lines: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const t = `t${7000 + i}`;
      const push = (o: unknown) => lines.push(JSON.stringify(o));
      push({ op: "start", id: t, kind: "turn" });
      push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
      push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } });
      push({ op: "stop", id: `${t}_u` });
      push({ op: "stop", id: t });
    }
    mkdirSync(join(fx.HOME, "local"), { recursive: true });
    writeFileSync(opsPath(uri), lines.join("\n") + "\n", "utf-8");

    await fx.sh.getJson(`./diy.sh agent local compact plan set ${uri} ${keepFile("c", KEEP_C)}`);
    const cur = (await planVersions(uri)).current;
    const rec = (await fx.sh.getJson(`./diy.sh agent local compact run ${uri} --budget-bytes 0`)).data as unknown as {
      plan?: { budgetBytes: number; source: string; planVersion?: string; keep?: unknown };
    };
    const plan = rec.plan!;
    expect(plan.planVersion).toBe(cur);
    expect(plan.source).toBe("config");
    expect(plan.keep).toBeUndefined(); // ← 全文不再内嵌
    // 落盘原样复核（返回对象与账本同一份）
    const row = JSON.parse(readFileSync(compactFile(uri), "utf-8").trim().split("\n").at(-1)!);
    expect(row.plan.planVersion).toBe(cur);
    expect(row.plan.keep).toBeUndefined();
    // 指针可回查：CAS 里就是那一版全文
    const doc = JSON.parse(readFileSync(join(fx.HOME, "plan-store", `${cur}.json`), "utf-8"));
    expect(doc.keep.map((k: { type: string }) => k.type)).toEqual(["steps"]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  }, 120_000);
});
