// tests/core/room-member-alias.test.ts
// 🎯 成员别名：从 backend 派生，让「两个任务 agent 同室」可寻址（##377 第 21 刀）
//
// 背景（lab 实测，projects/1/tasks/1 的 room 里邀两个任务进来）：
//   agent:main                  name=deepseek-4.1-flash  backend=tasks/1
//   agent:deepseek-4.1-flash    name=deepseek-4.1-flash  backend=tasks/2
//   agent:deepseek-4.1-flash-2  name=deepseek-4.1-flash  backend=tasks/3
// 三行 name 完全相同（都来自人物名）⇒
//   ① `@deepseek-4.1-flash` 命中第一个（正好是主人格），后两个**永远打不到**；
//   ② 完整 id `@agent:deepseek-4.1-flash` 被 `ADDRESS_RE` 的 `:` 排除截成 `@agent` ⇒ 也打不到；
//   ③ 报错提示给的是「可选：@deepseek-4.1-flash / @deepseek-4.1-flash」—— 两个一样的名字。
//
// 判据：
//   ① `memberAlias` 从 backend 派生（`.../tasks/3` → `t3`）；无 backend ⇒ undefined
//   ② name **不唯一时不猜**（原实现 find 取第一个 = 静默投给主人格）
//   ③ name 唯一时照旧命中（回归网：单人任务一个字不能变）
//   ④ 别名**唯一**时命中
//   ⑤ 别名不唯一时同样不猜
//   ⑥ `memberLabel` 单人任务不带别名（与旧版逐字一致），多人带
//   ⑦ `memberOptions` 给「可打的键 + 人名」：`@t3(deepseek-4.1-flash)`

import { describe, it, expect } from "vitest";
import {
  memberAlias,
  memberLabel,
  memberOptions,
  resolveMember,
  type RoomBackend,
  type RoomMember,
} from "../../src/shared/room";

const task = (uri: string): RoomBackend => ({ type: "task", data: { taskUri: uri } });

const m = (id: string, name: string, taskUri?: string): RoomMember =>
  ({ id, name, kind: "agent", backend: taskUri ? task(taskUri) : null, persona: "persona/1" }) as RoomMember;

/** 第 21 刀 lab 里的真实形状：三个 agent，name 全同 */
const SAME_NAME = {
  members: [
    { id: "human:chen56", name: "chen56", kind: "human", backend: null } as RoomMember,
    m("agent:main", "deepseek-4.1-flash", "projects/1/tasks/1"),
    m("agent:deepseek-4.1-flash", "deepseek-4.1-flash", "projects/1/tasks/2"),
    m("agent:deepseek-4.1-flash-2", "deepseek-4.1-flash", "projects/1/tasks/3"),
  ],
};

describe("memberAlias —— 从 backend 派生（##377 第 21 刀）", () => {
  it("① taskUri 末段 → `t<n>`", () => {
    expect(memberAlias(m("agent:main", "x", "projects/1/tasks/1"))).toBe("t1");
    expect(memberAlias(m("agent:a", "x", "projects/1/tasks/42"))).toBe("t42");
  });

  it("①' 无 backend / 非 task 分支 ⇒ undefined", () => {
    expect(memberAlias(m("agent:a", "x"))).toBeUndefined();
    expect(memberAlias({ id: "human:chen56", name: "chen56", kind: "human", backend: null })).toBeUndefined();
  });
});

describe("resolveMember —— 同名多成员（第 21 刀修的真 bug）", () => {
  it("② name 不唯一 ⇒ **不猜**（原实现会静默投给第一个 = 主人格）", () => {
    const ids = SAME_NAME.members.map((x) => x.id);
    // 解析不出 ⇒ 原样返回（既有语义），且**绝不能**是任何一个真实成员 id
    for (const input of ["deepseek-4.1-flash", "@deepseek-4.1-flash"]) {
      const got = resolveMember(SAME_NAME, input);
      expect(ids).not.toContain(got);
    }
  });

  it("③ name 唯一 ⇒ 照旧命中（回归网）", () => {
    const room = {
      members: [m("agent:main", "deepseek-4.1-flash", "projects/1/tasks/1"), m("agent:x", "for-test", "projects/1/tasks/9")],
    };
    expect(resolveMember(room, "deepseek-4.1-flash")).toBe("agent:main");
    expect(resolveMember(room, "@for-test")).toBe("agent:x");
  });

  it("④ 别名唯一 ⇒ 命中（`@t3` 打到 tasks/3 那个）", () => {
    expect(resolveMember(SAME_NAME, "t1")).toBe("agent:main");
    expect(resolveMember(SAME_NAME, "t2")).toBe("agent:deepseek-4.1-flash");
    expect(resolveMember(SAME_NAME, "@t3")).toBe("agent:deepseek-4.1-flash-2");
  });

  it("⑤ 别名不唯一 ⇒ 同样不猜", () => {
    const dup = {
      members: [m("agent:a", "甲", "projects/1/tasks/7"), m("agent:b", "乙", "projects/2/tasks/7")],
    };
    expect(resolveMember(dup, "t7")).toBe("t7");
  });

  it("⑤' 精确 id 仍然优先于一切（逃生口最硬）", () => {
    expect(resolveMember(SAME_NAME, "agent:deepseek-4.1-flash-2")).toBe("agent:deepseek-4.1-flash-2");
  });
});

describe("memberLabel / memberOptions —— 提示文案", () => {
  it("⑥ 单人任务（仅 1 个 agent）不带别名 ⇒ 与旧版逐字一致", () => {
    const solo = { members: [m("agent:main", "deepseek-4.1-flash", "projects/1/tasks/1")] };
    expect(memberLabel(solo, "agent:main")).toBe("deepseek-4.1-flash");
  });

  // 第 22 刀改格式：`name·t3` → `name（@t3）`（review3 R2 —— 别名得写成**能打的形态**，
  // 光写 `t3` 没人知道要打 `@t3`）。断言随实现更新，语义未变：多 agent 必须露别名。
  it("⑥' 多 agent 时带别名（人读得懂、也看得出该打什么）", () => {
    expect(memberLabel(SAME_NAME, "agent:deepseek-4.1-flash-2")).toBe("deepseek-4.1-flash（@t3）");
  });

  it("⑦ memberOptions 给「可打的键(人名)」", () => {
    expect(memberOptions(SAME_NAME)).toEqual([
      "@t1(deepseek-4.1-flash)",
      "@t2(deepseek-4.1-flash)",
      "@t3(deepseek-4.1-flash)",
    ]);
  });

  it("⑦' 无 backend 的 agent 回落 `@name`（不编造别名）", () => {
    expect(memberOptions({ members: [m("agent:a", "dev")] })).toEqual(["@dev"]);
  });
});
