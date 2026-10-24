// ##408 刀 10：进程组名册 —— 记不住它，`nohup xxx &` 起的孤儿就认领不回来。
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnedGroups } from "../../src/main/services/owned-groups";

const base = { at: 1000, command: "bash -c x", cwd: "/tmp" };

describe("OwnedGroups — 登记与补录", () => {
  it("登记后可按组号取回", () => {
    const g = new OwnedGroups();
    g.record(120, base);
    expect(g.get(120)?.command).toBe("bash -c x");
    expect(g.size()).toBe(1);
  });

  it("非法组号（0 / 负数 / 非整数）直接忽略（不许污染名册）", () => {
    const g = new OwnedGroups();
    for (const bad of [0, -5, 1.5, Number.NaN]) g.record(bad, base);
    expect(g.size()).toBe(0);
  });

  it("同组重复登记只**补空字段**（taskUri / runId），其余以首次为准", () => {
    const g = new OwnedGroups();
    g.record(120, base);
    g.record(120, { ...base, command: "另一条命令", taskUri: "projects/1/tasks/1", runId: "r-1" });
    expect(g.get(120)).toEqual({ ...base, taskUri: "projects/1/tasks/1", runId: "r-1" });
  });

  it("名册有上限：先剪**没有活口**的组，活着的组绝不丢（重启后靠它认孤儿）", () => {
    // 组 777 是"活的"，其余都是死的（注入判据，不真起进程）
    const g = new OwnedGroups({ alive: (pgid) => pgid === 777 });
    g.record(777, { ...base, at: 1 }); // 最老，但活着 ⇒ 不许被剪
    for (let i = 2; i <= 600; i++) g.record(i, { ...base, at: i });
    expect(g.size()).toBeLessThanOrEqual(512);
    expect(g.get(777)).toBeTruthy();
    expect(g.get(2)).toBeUndefined(); // 死组里最老的先走
  });

  it("剪枝后落盘也是剪过的（先 save 后 delete 会让盘上留幽灵条目）", () => {
    const file = join(mkdtempSync(join(tmpdir(), "diy-grp-")), "groups.json");
    const g = new OwnedGroups({ file, alive: () => false });
    for (let i = 1; i <= 600; i++) g.record(i, { ...base, at: i });
    const raw = JSON.parse(readFileSync(file, "utf8")) as Array<{ pgid: number }>;
    expect(raw.length).toBeLessThanOrEqual(512);
    expect(raw.some((x) => x.pgid === 1)).toBe(false);
  });
});

describe("OwnedGroups.retain — 清理（但别把刚登记的清掉）", () => {
  it("组里一个进程都不剩、且已过宽限期 ⇒ 丢掉", () => {
    const g = new OwnedGroups();
    g.record(120, { ...base, at: 1000 });
    g.retain(new Set(), 1000 + 60_000);
    expect(g.size()).toBe(0);
  });

  it("刚登记 30s 内先留着（否则刚起就被扫描会把它删掉）", () => {
    const g = new OwnedGroups();
    g.record(120, { ...base, at: 1000 });
    g.retain(new Set(), 1000 + 1_000);
    expect(g.size()).toBe(1);
  });

  it("组里还有活进程 ⇒ 保留", () => {
    const g = new OwnedGroups();
    g.record(120, { ...base, at: 1000 });
    g.retain(new Set([120]), 1000 + 3_600_000);
    expect(g.size()).toBe(1);
  });
});

describe("OwnedGroups — 落盘索引（app 重启后仍认得出孤儿）", () => {
  const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "diy-groups-")), "groups.json");

  it("登记即写盘；新实例读回同一批组号（孤儿 ppid 已是 launchd，只靠这个索引）", () => {
    const file = tmpFile();
    const a = new OwnedGroups({ file });
    a.record(60534, { ...base, taskUri: "projects/1/tasks/5" });
    const b = new OwnedGroups({ file });
    expect(b.get(60534)?.command).toBe("bash -c x");
    expect(b.get(60534)?.taskUri).toBe("projects/1/tasks/5");
  });

  it("坏文件 ⇒ 当空，不影响启动（索引可丢可重建）", () => {
    const file = tmpFile();
    writeFileSync(file, "{ 这不是 JSON", "utf8");
    expect(new OwnedGroups({ file }).size()).toBe(0);
  });

  it("清理后落盘也跟着少（不会越积越多）", () => {
    const file = tmpFile();
    const a = new OwnedGroups({ file });
    a.record(1, { ...base, at: 1000 });
    a.retain(new Set(), 1000 + 60_000);
    expect(new OwnedGroups({ file }).size()).toBe(0);
  });
});
