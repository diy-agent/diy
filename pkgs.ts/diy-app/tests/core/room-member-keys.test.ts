// tests/core/room-member-keys.test.ts
// 🎯 「提示给的名字必须真能打中」—— 可用键 / 两把钥匙 / 同一把尺（##377 第 22 刀；review3 R2·R3·R5）
//
// 三个病灶（都来自 review3，不是猜测）：
//   ① R2：报错提示只说人物名，而两个任务 agent 同室时**人物名打不中**（歧义）——
//         系统告诉用户一把打不开门的钥匙。
//   ② R3：`shortName` 取「第一个 `:` 之后」，`resolveMember` 的短名匹配取 `split(":").pop()`
//          ⇒ 三段 id（`agent:foo:bar`）上「显示 `foo:bar`、能打中 `bar`」。
//   ③ R5：`--to "@"` 这种空名会渲染成 `@@ 不是房间成员`。
//
// 判据：
//   ① 名字**唯一** ⇒ 首选键 = 名字（单人 / 无重名场景一个字不变）
//   ② 名字**不唯一** ⇒ 名字**不进**候选键，别名顶上（打中 = 用户真的投到他）
//   ③ `memberOptions` 输出「@键(人名)」，键必须是 `memberKeys` 里的
//   ④ `memberLabel` 多 agent 时带 `（@键）`，单 agent 只给名字（第 17 刀逐字一致回归网）
//   ⑤ `shortName === lastSegment`；三段 id 上「显示」与「匹配」同一把尺
//   ⑥ `addrDisplay("@")` 不是 `@@`

import { describe, it, expect } from "vitest";
import {
  addrDisplay,
  deliveryHint,
  lastSegment,
  memberKey,
  memberKeys,
  memberLabel,
  memberOptions,
  resolveMember,
  shortName,
  type RoomBackend,
  type RoomMember,
} from "../../src/shared/room";

const task = (uri: string): RoomBackend => ({ type: "task", data: { taskUri: uri } });
const m = (id: string, name: string, taskUri?: string): RoomMember =>
  ({ id, name, kind: "agent", backend: taskUri ? task(taskUri) : null, persona: "persona/1" }) as RoomMember;
const human = (id: string, name: string): RoomMember =>
  ({ id, name, kind: "human", backend: null }) as RoomMember;

/** 第 21 刀 lab 里的真实形状：三个 agent，name 全同 */
const SAME_NAME = {
  members: [
    human("human:chen56", "chen56"),
    m("agent:main", "deepseek-4.1-flash", "projects/1/tasks/1"),
    m("agent:deepseek-4.1-flash", "deepseek-4.1-flash", "projects/1/tasks/2"),
    m("agent:deepseek-4.1-flash-2", "deepseek-4.1-flash", "projects/1/tasks/3"),
  ],
};

/** 单人任务：人 + 主人格（第 17 刀判据 1/7 的形状） */
const SINGLE = {
  members: [human("human:chen56", "chen56"), m("agent:main", "deepseek-4.1-flash", "projects/1/tasks/1")],
};

/** 两个**不同**人物名的 agent —— 名字唯一，名字就该是首选键 */
const DISTINCT = {
  members: [
    human("human:chen56", "chen56"),
    m("agent:main", "deepseek-4.1-flash", "projects/1/tasks/1"),
    m("agent:review", "mimo2.6", "projects/1/tasks/2"),
  ],
};

describe("memberKeys / memberKey —— 该打什么名字的真源", () => {
  it("① 名字唯一 ⇒ 首选键就是名字（回归网，不多给噪声）", () => {
    const review = DISTINCT.members[2]!;
    expect(memberKey(DISTINCT, review)).toBe("mimo2.6");
    // 别名与 id 末段仍在候选里（能打中，只是不首选）
    expect(memberKeys(DISTINCT, review)).toEqual(["mimo2.6", "t2", "review"]);
  });

  it("② 名字**不唯一** ⇒ 名字不进候选，别名顶上（否则提示的是把打不开门的钥匙）", () => {
    const [, main, second, third] = SAME_NAME.members as RoomMember[];
    expect(memberKeys(SAME_NAME, main!)).toEqual(["t1", "main"]);
    expect(memberKey(SAME_NAME, main!)).toBe("t1");
    expect(memberKey(SAME_NAME, second!)).toBe("t2");
    expect(memberKey(SAME_NAME, third!)).toBe("t3");
    // 反证：三个键互不相同 —— 若名字进了候选，三者会都是 `deepseek-4.1-flash`
    const keys = SAME_NAME.members.filter((x) => x.kind === "agent").map((x) => memberKey(SAME_NAME, x));
    expect(new Set(keys).size).toBe(3);
  });

  it("② 键**真的能打中**（与 resolveMember 同源，不是文字游戏）", () => {
    const agents = SAME_NAME.members.filter((x) => x.kind === "agent");
    for (const a of agents) {
      expect(resolveMember(SAME_NAME, memberKey(SAME_NAME, a))).toBe(a.id);
    }
    // 而人物名打不中任何一个 —— 这正是「提示必须给别名」的理由
    expect(SAME_NAME.members.some((x) => resolveMember(SAME_NAME, "deepseek-4.1-flash") === x.id)).toBe(false);
  });

  it("③ memberOptions 给「@键(人名)」且键都在 memberKeys 里", () => {
    const opts = memberOptions(SAME_NAME);
    expect(opts).toEqual([
      "@t1(deepseek-4.1-flash)",
      "@t2(deepseek-4.1-flash)",
      "@t3(deepseek-4.1-flash)",
    ]);
    const keys = SAME_NAME.members.filter((x) => x.kind === "agent").map((x) => memberKey(SAME_NAME, x));
    for (const o of opts) expect(keys).toContain(o.slice(1, o.indexOf("(")));
  });

  it("③ 名字唯一时 memberOptions 不给括号（`@mimo2.6` 就够）", () => {
    expect(memberOptions(DISTINCT)).toEqual(["@deepseek-4.1-flash", "@mimo2.6"]);
  });
});

describe("memberLabel —— 两把钥匙（review3 R2）", () => {
  it("④ 多 agent：`人名（@键）`", () => {
    expect(memberLabel(SAME_NAME, "agent:deepseek-4.1-flash-2")).toBe("deepseek-4.1-flash（@t3）");
  });

  it("④ 单 agent：只给名字（第 17 刀「逐字不变」的回归网）", () => {
    expect(memberLabel(SINGLE, "agent:main")).toBe("deepseek-4.1-flash");
  });
});

describe("同一把尺（review3 R3）", () => {
  it("⑤ shortName 就是 lastSegment；三段 id 上「显示」= 「能打中」", () => {
    expect(shortName).toBe(lastSegment);
    expect(lastSegment("agent:foo:bar")).toBe("bar");
    // 旧实现：shortName 给 "foo:bar"（显示）、resolveMember 认 "bar"（匹配）
    expect(shortName("agent:foo:bar")).toBe("bar");

    const room = { members: [human("human:chen56", "chen56"), m("agent:foo:bar", "bar", "projects/1/tasks/9")] };
    expect(resolveMember(room, shortName("agent:foo:bar"))).toBe("agent:foo:bar");
  });
});

describe("提示文案不出现 `@@`（review3 R5）", () => {
  it("⑥ 空名 / 已带 @ 的名字都渲染成一个 @", () => {
    expect(addrDisplay("@")).toBe("@（名字为空）");
    expect(addrDisplay("")).toBe("@（名字为空）");
    expect(addrDisplay("main")).toBe("@main");
    expect(addrDisplay("@agent:main")).toBe("@main");
  });
});

describe("deliveryHint —— 输入框上方那条提示（review3 R2）", () => {
  it("投给同名的某个成员 ⇒ 名字 + 可打的键", () => {
    expect(deliveryHint(["agent:deepseek-4.1-flash-2"], SAME_NAME, "explicit")).toBe(
      "将投递给 deepseek-4.1-flash（@t3）",
    );
  });

  it("打了歧义的人物名 ⇒ 报错并给**能打中**的候选（不是三个一样的名字）", () => {
    const hint = deliveryHint(["deepseek-4.1-flash"], SAME_NAME, "explicit");
    expect(hint).toBe(
      "@deepseek-4.1-flash 不是房间成员（可选：@t1(deepseek-4.1-flash) / @t2(deepseek-4.1-flash) / @t3(deepseek-4.1-flash)）",
    );
    // 反证：提示里每个 `@键` 都必须真的能打中（review3 的心结：提示别给打不开门的钥匙）
    for (const k of hint.matchAll(/@([^\s（）()、]+)(?=\()/g)) {
      expect(resolveMember(SAME_NAME, k[1]!)).not.toBe(k[1]);
    }
  });

  it("单人房间照旧（不带别名、不带括号）", () => {
    expect(deliveryHint(["agent:main"], SINGLE, "focus")).toBe("将投递给 deepseek-4.1-flash");
  });
});
