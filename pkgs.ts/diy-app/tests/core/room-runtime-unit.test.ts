// tests/core/room-runtime-unit.test.ts
// 🎯 `runtime.room` 作为**两个原子单元**的形状与增量（##377 第 26 刀 · owner 口径）
//
// 为什么这条单测是这一刀的第一件事：搬家的价值全在「结构化 + 按 place 增量」，
// 而判据是 `renderedHash` **按 place 逐条比**（`shared/context/projection.ts`）。
// 合成一个单元 ⇒ 成员改个名就把整段 recent 重发一遍 diff（白烧 token）。
//   · 单元名单：`room.members` / `room.recent` 都在 `PLACE_CANDIDATES` 且归 runtime
//   · 值形状：结构化（members: id/name/key/main；recent: from/at/text + omitted）
//   · 增量：只改成员 ⇒ diff **只有** `room.members` 一条；只多一句发言 ⇒ **只有** `room.recent`
//   · 空 recent ⇒ 该单元**缺席**（不产出空节点，也不产生高频 diff）

import { describe, it, expect } from "vitest";
import { buildDelivery, PLACE_CANDIDATES } from "../../src/shared/context/delivery";
import { project } from "../../src/shared/context/projection";
import type { ContextPath } from "../../src/shared/context/types";
import type { RoomMembersValue, RoomRecentValue } from "../../src/shared/room";

const MEMBERS: RoomMembersValue = {
  roomId: "projects/1/tasks/1",
  name: "#1",
  list: [
    { id: "human:chen56", name: "chen56", key: "chen56", main: false },
    { id: "agent:main", name: "deepseek-4.1-flash", key: "main", main: true },
  ],
};
const RECENT: RoomRecentValue = {
  items: [{ from: "chen56", at: "2026-10-20T10:00:01.000Z", text: "先跑一下测试" }],
  omitted: 0,
};

const PLACES = ["room.members", "room.recent"] as ContextPath[];

/** 与真发同一条链：globals（已含 room）→ buildDelivery。
 *  system 名单给空数组 ⇒ 全部按候选的缺省归位（`room.*` 是 runtime） */
function delivery(room: unknown): ReturnType<typeof buildDelivery> {
  return buildDelivery({ room, task: { uri: "projects/1/tasks/1" } }, []);
}

/** 真发的树：**直接用 buildDelivery 产出的那份**（place 已按「整条 path 存在」裁过） */
function treeOf(room: unknown) {
  return delivery(room).tree;
}

/**
 * 从 t1 走到 t2 的 runtime 增量。
 *
 * `placementEpoch` / `wireVersion` 取 **t2 自己的值**：真实运行时它们是**同一棵树**上
 * 延续的计数（本次没有改 placement 就不该变）；这里每次重建树会各自累加，
 * 不归一化的话 `project` 会判成「placement 变了 ⇒ 重发全量 snapshot」，测不到逐 place 的增量。
 */
function diffOf(t1: ReturnType<typeof treeOf>, t2: ReturnType<typeof treeOf>) {
  const first = project(t1, null);
  const cursor = { ...first.cursor, wireVersion: t2.wireVersion, placementEpoch: t2.placementEpoch };
  return project(t2, cursor).projection.runtime;
}

/** set 动作的正文（remove 没有 content —— 类型上是判别联合，得先收窄） */
function contentOf(op: unknown): string {
  const o = op as { op?: string; content?: string };
  return o.op === "set" ? (o.content ?? "") : "";
}

describe("单元名单", () => {
  it("room.members / room.recent 都在候选里，且都归 runtime（不进 system 前缀缓存）", () => {
    const byPath = new Map(PLACE_CANDIDATES.map((c) => [c.path, c]));
    for (const p of PLACES) {
      expect(byPath.has(p), `缺 ${p}`).toBe(true);
      expect(byPath.get(p)!.system).toBe(false);
    }
  });
});

describe("值形状（结构化，不是拼好的中文）", () => {
  it("runtime 信封里是 YAML 结构：members 有 key/main，recent 有 from/at/text + omitted", () => {
    const d = delivery({ members: MEMBERS, recent: RECENT });
    expect(d.runtime.text).toContain("runtime:");
    expect(d.runtime.text).toContain("room:");
    expect(d.runtime.text).toContain("members:");
    expect(d.runtime.text).toContain("main: true");
    expect(d.runtime.text).toContain("key: chen56");
    expect(d.runtime.text).toContain("recent:");
    expect(d.runtime.text).toContain("from: chen56");
    expect(d.runtime.text).toContain("先跑一下测试");
    expect(d.runtime.text).toContain("omitted: 0");
    // 反证：不许是「一段拼好的话」（旧通道的段头不该再出现）
    expect(d.runtime.text).not.toContain("本房间近期发言");
  });

  it("recent 缺席 ⇒ 只出成员单元（不产生空节点）", () => {
    const d = delivery({ members: MEMBERS });
    expect(d.runtime.text).toContain("room:");
    expect(d.runtime.text).not.toContain("recent:");
  });
});

describe("增量按 place 逐条比（这是拆两个单元的理由）", () => {
  it("只改成员 ⇒ diff 只有 room.members 一条", () => {
    const t1 = treeOf({ members: MEMBERS, recent: RECENT });
    const t2 = treeOf({
      members: { ...MEMBERS, list: [...MEMBERS.list, { id: "agent:t3", name: "review", key: "t3", main: false }] },
      recent: RECENT,
    });
    const diff = diffOf(t1, t2);
    expect(diff.kind).toBe("patch");
    const ops = diff.kind === "patch" ? diff.ops : [];
    expect(ops.map((o) => o.path)).toEqual(["room.members"]);
    expect(contentOf(ops[0])).toContain("review");
  });

  it("只多一句发言 ⇒ diff 只有 room.recent 一条（成员不重发）", () => {
    const t1 = treeOf({ members: MEMBERS, recent: RECENT });
    const t2 = treeOf({
      members: MEMBERS,
      recent: { items: [...RECENT.items, { from: "main", at: "2026-10-20T10:00:09.000Z", text: "收到" }], omitted: 0 },
    });
    const diff = diffOf(t1, t2);
    const ops = diff.kind === "patch" ? diff.ops : [];
    expect(ops.map((o) => o.path)).toEqual(["room.recent"]);
    expect(contentOf(ops[0])).toContain("收到");
  });

  it("什么都没变 ⇒ `none`（不注入、不砸前缀缓存）", () => {
    const t1 = treeOf({ members: MEMBERS, recent: RECENT });
    expect(diffOf(t1, t1).kind).toBe("none");
  });

  it("recent 从有到无（水位前移后没新发言）⇒ 只 remove room.recent，成员留着", () => {
    const t1 = treeOf({ members: MEMBERS, recent: RECENT });
    const t2 = treeOf({ members: MEMBERS });
    const diff = diffOf(t1, t2);
    const ops = diff.kind === "patch" ? diff.ops : [];
    expect(ops.map((o) => `${o.op}:${o.path}`)).toEqual(["remove:room.recent"]);
  });
});
