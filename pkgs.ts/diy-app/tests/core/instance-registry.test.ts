// 实例注册表：启动写入 → 就绪回填 → 退出清理；**读取侧按 pid 存活过滤**（退出清理不保证执行）。
//
// 为什么要单测存活过滤：正常退出删条目是「尽力」，SIGKILL / 崩溃 / 测试 harness 的 SIGTERM
// 都不会跑退出钩子 —— 「关掉一个实例，下次 ls 不再出现」这条验收实际靠的是过滤，不是删除。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPidAlive,
  parseRecord,
  pruneRecords,
  readRecord,
  readRecords,
  recordPath,
  removeRecord,
  snapshotParents,
  updateRecord,
  writeRecord,
  type InstanceRecord,
} from "../../src/main/core/instance-registry";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "diy-inst-reg-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function record(over: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    pid: process.pid,
    port: null,
    diyHome: "/tmp/home",
    variant: "preview",
    env: "development",
    argv: ["/x/Electron", "/x/build/preview/main/index.mjs"],
    cwd: "/x",
    startedAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    parents: [{ pid: 42, command: "bash ./sha.sh preview" }],
    ...over,
  };
}

describe("parseRecord（宽松：拿不准就作废整条）", () => {
  it("合格对象原样通过", () => {
    const r = parseRecord(record({ pid: 7, port: 18888 }));
    expect(r).toMatchObject({ pid: 7, port: 18888, diyHome: "/tmp/home", variant: "preview" });
    expect(r?.parents).toEqual([{ pid: 42, command: "bash ./sha.sh preview" }]);
  });

  it("缺 pid / pid 非数 / 缺 diyHome / port 类型不对 → null（绝不拿半个对象去渲染）", () => {
    expect(parseRecord({ port: null, diyHome: "/h" })).toBeNull();
    expect(parseRecord({ pid: "9", port: null, diyHome: "/h" })).toBeNull();
    expect(parseRecord({ pid: 9, port: null })).toBeNull();
    expect(parseRecord({ pid: 9, port: "18888", diyHome: "/h" })).toBeNull();
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord("nope")).toBeNull();
  });

  it("parents 里的坏跳被丢掉，其余保留", () => {
    const r = parseRecord({ pid: 9, port: null, diyHome: "/h", parents: [{ pid: 1, command: "x" }, { pid: "bad" }, {}] });
    expect(r?.parents).toEqual([{ pid: 1, command: "x" }]);
  });
});

describe("isPidAlive / pruneRecords", () => {
  it("自己活着；一个几乎不可能存在的 pid 死着", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(4194303)).toBe(false);
  });

  it("按判定器过滤（不依赖真实进程表）", () => {
    const recs = [record({ pid: 1 }), record({ pid: 2 }), record({ pid: 3 })];
    expect(pruneRecords(recs, (pid) => pid !== 2).map((r) => r.pid)).toEqual([1, 3]);
  });
});

describe("写 / 读 / 回填 / 删", () => {
  it("写后能读回；updateRecord 合并字段并刷新 updatedAt", () => {
    const dir = scratch();
    writeRecord(dir, record({ pid: 11 }));
    expect(readRecord(dir, 11)?.port).toBeNull();
    updateRecord(dir, 11, { port: 19999 });
    const back = readRecord(dir, 11);
    expect(back?.port).toBe(19999);
    expect(back?.diyHome).toBe("/tmp/home");
  });

  it("updateRecord 对不存在的记录**不凭空造**（写与更新不是同一件事）", () => {
    const dir = scratch();
    updateRecord(dir, 12, { port: 1 });
    expect(readRecord(dir, 12)).toBeNull();
  });

  it("readRecords 过滤死 pid 并顺手删掉死者的文件（退出清理没跑也不留垃圾）", () => {
    const dir = scratch();
    writeRecord(dir, record({ pid: process.pid }));
    writeRecord(dir, record({ pid: 4194303 }));
    const alive = readRecords(dir);
    expect(alive.map((r) => r.pid)).toEqual([process.pid]);
    expect(existsSync(recordPath(dir, 4194303))).toBe(false);
  });

  it("坏 JSON 文件被跳过并清掉（别人写的文件没有信任基础）", () => {
    const dir = scratch();
    writeFileSync(join(dir, "13.json"), "{ 这不是 json");
    expect(readRecords(dir)).toEqual([]);
    expect(readdirSync(dir)).not.toContain("13.json");
  });

  it("目录不存在 → 空表（第一次跑，正常态而非错误）", () => {
    expect(readRecords(join(tmpdir(), "diy-inst-not-exist-xyz"))).toEqual([]);
  });

  it("removeRecord 幂等（已不在也不是错）", () => {
    const dir = scratch();
    writeRecord(dir, record({ pid: 14 }));
    removeRecord(dir, 14);
    removeRecord(dir, 14);
    expect(readRecord(dir, 14)).toBeNull();
  });

  it("原子写：目录里不留临时文件", () => {
    const dir = scratch();
    writeRecord(dir, record({ pid: 15 }));
    expect(readdirSync(dir)).toEqual(["15.json"]);
  });
});

describe("snapshotParents（启动瞬间才拿得到的「谁开的」）", () => {
  it("逐级上溯到 depth / pid≤1 / 查不到为止", () => {
    const chain: Record<number, { hop: { pid: number; command: string }; ppid: number }> = {
      100: { hop: { pid: 100, command: "bash ./sha.sh preview" }, ppid: 50 },
      50: { hop: { pid: 50, command: "zsh" }, ppid: 1 },
    };
    expect(snapshotParents(100, (pid) => chain[pid] ?? null)).toEqual([
      { pid: 100, command: "bash ./sha.sh preview" },
      { pid: 50, command: "zsh" },
    ]);
  });

  it("查不到（父已退 / ppid=1）→ 空链，不抛", () => {
    expect(snapshotParents(1, () => null)).toEqual([]);
    expect(snapshotParents(999, () => null)).toEqual([]);
  });

  it("自环不会死循环", () => {
    expect(snapshotParents(5, (pid) => ({ hop: { pid, command: "x" }, ppid: pid }))).toEqual([{ pid: 5, command: "x" }]);
  });
});
