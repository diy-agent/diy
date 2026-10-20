// tests/core/room-mirror.test.ts
// 🎯 双向可见：把「投进去的那句」与「这一轮的回复」写回**接收方自己的房间**（##377 第 24 刀）
//
// 病灶（用户原话「不能真正使用」里最硬的一条）：
//   投递只记在**源房间**的事件流里 ⇒ 接收方房间 `room get <它>` 恒为 0 事件。
//   人在这边看见「投过去了」，切到接收方那间屋子却什么都没有（消息与房间脱节）。
//
// 判据：
//   ① **同一房间不写回**（任务页对主人格自己说话 = 本来就在一条流里，写了就是重复）
//   ② 两份事件都带 `origin = { roomId, sayId }` —— 接收方据此知道「从哪来」
//   ③ 形状**恰好**让任务页不重复画：`opsOwnsEvent(say) === true`（to 含主人格）
//      且 `opsOwnsEvent(reply) === true`（ref.memberUri = 主人格）—— 第 16 刀判据 7 的回归网
//   ④ 失败轮：`reply.delivered === false` 且带 `error`（不把失败伪装成成功）
//   ⑤ `originLabel` 给人读的短名（`#3` / 侧边栏实例名），不出现路径噪音

import { describe, it, expect } from "vitest";
import { mirrorEvents, mirrorMissingParts, opsOwnsEvent, originLabel, shouldMirrorRoom } from "../../src/shared/room";

const base = {
    origin: { roomId: "projects/1/tasks/1", sayId: "e1_say" },
    targetRoomId: "projects/1/tasks/3",
    targetMemberId: "agent:main",
    author: "human:chen56",
    text: "帮我看一下这个 bug",
    replyText: "收到，我看过了",
    taskUri: "projects/1/tasks/3",
    turnId: "t1792500000001",
    ids: { say: "x_say", reply: "x_reply" },
    ts: "2026-10-20T10:00:00.000Z",
} as const;

describe("shouldMirrorRoom —— 什么时候写回", () => {
    it("① 同一房间不写回（任务页对主人格自己说话）", () => {
        expect(shouldMirrorRoom("projects/1/tasks/1", "projects/1/tasks/1")).toBe(false);
        expect(mirrorEvents({ ...base, targetRoomId: "projects/1/tasks/1" })).toBeNull();
    });

    it("② 不同房间写回", () => {
        expect(shouldMirrorRoom("projects/1/tasks/1", "projects/1/tasks/3")).toBe(true);
        expect(mirrorEvents(base)).not.toBeNull();
    });

    it("② 空 id 不写回（backend 缺失 / 侧边栏之外的怪形状）", () => {
        expect(shouldMirrorRoom("", "projects/1/tasks/3")).toBe(false);
        expect(shouldMirrorRoom("projects/1/tasks/1", "")).toBe(false);
    });
});

describe("mirrorEvents —— 两条事件的形状", () => {
    it("① say：投给接收方主人格 + 带来源", () => {
        const { say } = mirrorEvents(base)!;
        expect(say.kind).toBe("say");
        expect(say.author).toBe("human:chen56");
        expect(say.to).toEqual(["agent:main"]);
        expect(say.text).toBe("帮我看一下这个 bug");
        expect(say.origin).toEqual({ roomId: "projects/1/tasks/1", sayId: "e1_say" });
        expect(say.id).toBe("x_say");
        expect(say.channel).toBeTruthy();
    });

    it("① reply：归到接收方主人格那一轮，带 turnId 与来源", () => {
        const reply = mirrorEvents(base)!.reply!;
        expect(reply.kind).toBe("reply");
        expect(reply.author).toBe("agent:main");
        expect(reply.to).toEqual(["human:chen56"]);
        expect(reply.text).toBe("收到，我看过了");
        expect(reply.ref).toEqual({ memberUri: "agent:main", turnId: "t1792500000001" });
        expect(reply.sourceTask).toBe("projects/1/tasks/3");
        expect(reply.origin?.sayId).toBe("e1_say");
        expect(reply.delivered).toBe(true);
    });

    it("③ 形状让任务页**不重复画**（ops 流已经有这一轮）", () => {
        const ev = mirrorEvents(base)!;
        expect(opsOwnsEvent(ev.say)).toBe(true);
        expect(opsOwnsEvent(ev.reply!)).toBe(true);
        // 反证：换成别的成员 id（不是主人格）⇒ ops 不再认领 ⇒ 那个形状会让任务页多画一行
        const other = mirrorEvents({ ...base, targetMemberId: "agent:x" })!;
        expect(opsOwnsEvent(other.reply!)).toBe(false);
    });

    it("④ 失败轮不伪装成功", () => {
        const reply = mirrorEvents({ ...base, error: "对方这一轮没有产出文本" })!.reply!;
        expect(reply.delivered).toBe(false);
        expect(reply.error).toBe("对方这一轮没有产出文本");
    });

    it("② 没有 turnId 时不带 ref（不造一个空壳引用）", () => {
        const reply = mirrorEvents({ ...base, turnId: undefined })!.reply!;
        expect(reply.ref).toBeUndefined();
    });
});

describe("忙时插话：只写回 say（##377 第 27 刀）", () => {
    // 忙时投递不是"开一轮"，而是插进**正在跑的那一轮** ⇒ 没有属于这条投递的回复。
    // 写一条空回复会造出"说了话、没人回"的假象；不写又说不过去（话确实进了对方会话）。
    const steered = mirrorEvents({ ...base, replyText: undefined })!;

    it("① 只有 say，没有 reply", () => {
        expect(steered.say.kind).toBe("say");
        expect(steered.say.origin).toEqual({ roomId: "projects/1/tasks/1", sayId: "e1_say" });
        expect(steered.reply).toBeUndefined();
    });

    it("② 判据：这条 say 写回后仍然只缺 reply（不会每跑一次都「补」一条假回复）", () => {
        expect(mirrorMissingParts([steered.say], "e1_say")).toEqual({ say: false, reply: true });
    });
});

describe("originLabel —— 气泡上的「从哪来」", () => {
    it("① 任务房间 ⇒ `#号`", () => {
        expect(originLabel({ roomId: "projects/1/tasks/3", sayId: "e" })).toBe("来自 #3");
    });

    it("① 侧边栏房间 ⇒ 实例短名（不带 `sidebar-` 前缀、不带路径）", () => {
        expect(originLabel({ roomId: "agent:room:ui/sidebar-dev-ttipba", sayId: "e" })).toBe("来自 dev-ttipba");
    });

    it("① 本房间产出的事件（无 origin）不画", () => {
        expect(originLabel(undefined)).toBeNull();
        expect(originLabel(null)).toBeNull();
    });
});

describe("mirrorMissingParts —— 幂等按「每条」算（review2 R1）", () => {
    // 病灶：`say` 与 `reply` 是两次 append。崩在两次之间 / 第二次 append 抛错 ⇒ 盘上只有 say。
    // 若幂等判据是「这条 say 已经写回过 ⇒ 整体 return」，那条 reply **永远补不回来**
    // （房间里从此挂着「说了话、没人回」，重跑一百次也一样）。
    const both = mirrorEvents(base)!;

    it("① 两条都不在 ⇒ 两条都缺（首次写回）", () => {
        expect(mirrorMissingParts([], "e1_say")).toEqual({ say: true, reply: true });
    });

    it("② 只有 say 在 ⇒ **只缺 reply**（R1 的本体：补得上）", () => {
        expect(mirrorMissingParts([both.say], "e1_say")).toEqual({ say: false, reply: true });
    });

    it("③ 只有 reply 在（反向半截）⇒ 只缺 say", () => {
        expect(mirrorMissingParts([both.reply!], "e1_say")).toEqual({ say: true, reply: false });
    });

    it("④ 两条都在 ⇒ 都不缺（重跑静默）", () => {
        expect(mirrorMissingParts([both.say, both.reply!], "e1_say")).toEqual({ say: false, reply: false });
    });

    it("⑤ 别的 say 的事件不算数（按 origin.sayId 精确匹配，不是「房间里有 say 就算」）", () => {
        const other = mirrorEvents({ ...base, origin: { roomId: "projects/1/tasks/1", sayId: "e2_other" } })!;
        expect(mirrorMissingParts([other.say, other.reply!], "e1_say")).toEqual({ say: true, reply: true });
    });

    it("⑥ 空 sayId ⇒ 一律视为缺（防空串命中所有无 origin 事件造成的假幂等）", () => {
        const plain = { ...both.say, origin: undefined } as typeof both.say;
        expect(mirrorMissingParts([plain], "")).toEqual({ say: true, reply: true });
    });
});
