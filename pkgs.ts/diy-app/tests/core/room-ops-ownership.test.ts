// tests/core/room-ops-ownership.test.ts
// 🎯 任务页时间线的「谁显示谁」判据（##377 第 17 刀 / ##166 §44.2 B）
//
// 发送路径改走 room 之后，**主人格相关的东西两边都有**（room 事件流 + 本任务 ops 流）
// ⇒ 必须有**一条**判据定死归属。写错的症状只有两种：「重复一条」或「少一条」，
// 而且都要把页面点开才看得见 ⇒ 这四条组合（主人格/他人 × 发言/回复）在这里钉成回归网。

import { describe, it, expect } from "vitest";
import {
  HUMAN_MEMBER_ID,
  MAIN_MEMBER_ID,
  opsAuthorFor,
  opsOwnsEvent,
  resolveRecipients,
  type RoomMember,
} from "../../src/shared/room";

const MAIN = MAIN_MEMBER_ID; // agent:main
const DEV = "agent:dev";
const HUMAN = HUMAN_MEMBER_ID; // human:chen56

/** 人的发言（`to` = 收件人） */
const say = (to: string[]): Parameters<typeof opsOwnsEvent>[0] => ({ kind: "say", to, ref: undefined });
/**
 * 成员的回复：`to` 恒是**发起者**（人成员）—— 这正是「不能只看 to」的原因，
 * 故这条构造里刻意带上真实的 `to`，让"按 to 判"的错误在这里就暴露。
 */
const reply = (from: string): Parameters<typeof opsOwnsEvent>[0] => ({
  kind: "reply",
  to: [HUMAN],
  ref: { memberUri: from, turnId: "t1792420540087" },
});

const members = [
  { id: HUMAN, name: "chen56", kind: "human", backend: null },
  { id: MAIN, name: "mimo2.6", kind: "agent", backend: null, main: true },
  { id: DEV, name: "dev", kind: "agent", backend: null },
] as unknown as RoomMember[];

describe("opsOwnsEvent：任务页时间线的归属（四种组合）", () => {
  it("① 我说给主人格的话 ⇒ ops 流负责（room 侧跳过，不画第二条）", () => {
    expect(opsOwnsEvent(say([MAIN]), MAIN)).toBe(true);
  });

  it("② 我说给 dev 的话 ⇒ room 事件流负责（ops 流里没有它）", () => {
    expect(opsOwnsEvent(say([DEV]), MAIN)).toBe(false);
  });

  it("③ 主人格的回复 ⇒ ops 流负责（就是它自己会话里那一轮）", () => {
    expect(opsOwnsEvent(reply(MAIN), MAIN)).toBe(true);
  });

  it("④ dev 的回复 ⇒ room 事件流负责", () => {
    expect(opsOwnsEvent(reply(DEV), MAIN)).toBe(false);
  });

  it("反证：只按「to 含主人格」判 ⇒ ③ 会被判成 room 负责（主人格的回复画两遍）", () => {
    const naive = (e: Parameters<typeof opsOwnsEvent>[0]) => e.to.includes(MAIN);
    expect(naive(reply(MAIN))).toBe(false); // 漏判（reply 的 to 是发起者，不是回复者）
    expect(opsOwnsEvent(reply(MAIN), MAIN)).toBe(true); // 正确判据看 ref.memberUri
  });

  it("认不出的 kind 一律不画（白名单式：宁可少画，不可画错）", () => {
    expect(opsOwnsEvent({ kind: "system", to: [MAIN], ref: undefined } as never, MAIN)).toBe(true);
  });
});

describe("opsAuthorFor：投递落进成员会话的署名（§40 B 的第 17 刀收窄）", () => {
  it("投给主人格 + 发起者是人 ⇒ 不署名（无 @ 发送 = 与今天逐字一致 —— 判据 1/7）", () => {
    expect(opsAuthorFor(true, HUMAN)).toBeUndefined();
  });

  it("投给主人格 + 发起者是 agent ⇒ 署名（那是「别人在跟你说」）", () => {
    expect(opsAuthorFor(true, DEV)).toBe(DEV);
  });

  it("投给别的成员 ⇒ 恒署名（§40 B 原样）", () => {
    expect(opsAuthorFor(false, HUMAN)).toBe(HUMAN);
    expect(opsAuthorFor(false, DEV)).toBe(DEV);
  });
});

describe("任务 room 的 @main 不是笔记（§44.2 A 订正 §38.2）", () => {
  it("@main ⇒ 正常投给主人格（explicit）", () => {
    const r = resolveRecipients([MAIN], MAIN, members, HUMAN);
    expect(r.routing).toBe("explicit");
    expect(r.recipients).toEqual([MAIN]);
  });

  it("无 @ 且 focus = 主人格 ⇒ 投给主人格（与今天等价）", () => {
    const r = resolveRecipients([], MAIN, members, HUMAN);
    expect(r.routing).toBe("focus");
    expect(r.recipients).toEqual([MAIN]);
  });

  it("无 @ 且 focus = 别的 agent ⇒ 投给它（任务页的「当前接受者」语义）", () => {
    const r = resolveRecipients([], DEV, members, HUMAN);
    expect(r.recipients).toEqual([DEV]);
  });

  it("@ 自己 ⇒ note（§38.2 只对「自己」成立，与 room 无关）", () => {
    const r = resolveRecipients([HUMAN], MAIN, members, HUMAN);
    expect(r.routing).toBe("note");
    expect(r.recipients).toEqual([]);
  });
});
