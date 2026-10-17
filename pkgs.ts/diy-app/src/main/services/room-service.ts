// src/main/services/room-service.ts — 多人房间的**投递器**（房间的心脏）
//
// 职责（##166 §28.5 A）：room 是「投递 + 汇总层」——
//   ① 收下一条发言 → 解析收件人（`@X` 显式 / `focus` 隐式 / 都没有 = 只落盘）；
//   ② 对每个 agent 收件人，**在它自己的 task 会话里真起一轮**（复用 `LocalAgentManager.chat`，
//      不是本进程自导自演 —— 验收判据 3 的证据就在那个任务的 ops 流里）；
//   ③ 把它的回复**带署名**追加回房间事件流（判据 4）。
//
// 三条实现口径：
//   · 投递文本走 `shared/room.deliveryText` 包装 —— agent 在**自己的会话**里看不到房间上下文，
//     "谁在说 / 从哪来"只能压进正文（wire 层身份只有正文有效，##166 §16.2）；
//   · 事件**先落盘再 yield**（与 local-agent 的 seal 同一条铁律：消费端断开不丢尾）；
//   · 成员会话忙（已有轮次在跑）时**本切片不排队**：如实标「未投递 + 原因」，
//     绝不静默丢弃、也不自作主张塞进插话队列（那是 §28.6 待决 73 的题）。

import { getLocalAgent } from "./local-agent";
import { sessionRegistry } from "./session-registry";
import { appendEvent, nextEventId, readRoom } from "../core/room";
import {
    deliveryText,
    memberName,
    parseAddress,
    resolveMember,
    resolveRecipients,
    shortName,
    type Room,
    type RoomEvent,
    type RoomMember,
} from "../../shared/room";
import type { Op } from "./local-blocks";

/** 投递轮次结束原因（给日志/事件附注用的一句话） */
function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 该成员的会话此刻是不是有轮次在跑（判据：会话注册表，主进程内存权威） */
function isBusy(taskUri: string): boolean {
    return sessionRegistry.activeTurnList().some((t) => t.uri === taskUri);
}

/** 该成员能不能被投递（有 backend 的 agent） */
function deliverable(m: RoomMember | undefined): m is RoomMember & { backend: { type: "task"; data: { taskUri: string } } } {
    return !!m && m.kind === "agent" && m.backend?.type === "task";
}

/** 房间里的「人」（发消息的默认主体；最小切片一人一房） */
function humanOf(room: Room): RoomMember | undefined {
    return room.members.find((m) => m.kind === "human");
}

/**
 * 跑一轮并把 assistant 文本收成一条回复。
 *
 * 只收 `start.meta.role !== "user"` 的 text 块：开场 user 块同样是 text 块（##310 起两者同形），
 * 混进去会让"回复"里带上自己刚说的话（自问自答的假象）。
 */
async function runAndCollect(
    taskUri: string,
    text: string,
): Promise<{ reply: string; error?: string }> {
    const agent = getLocalAgent();
    const texts = new Map<string, string>();
    const errs: string[] = [];
    try {
        for await (const op of agent.chat(taskUri, text) as AsyncGenerator<Op>) {
            if (op.op === "start") {
                if (op.kind === "text" && op.meta?.["role"] !== "user") texts.set(op.id, "");
                if (op.kind === "error") errs.push("");
            } else if (op.op === "delta") {
                const c = op.fields["content"];
                if (typeof c === "string" && texts.has(op.id)) texts.set(op.id, texts.get(op.id)! + c);
                const msg = op.fields["message"];
                if (typeof msg === "string" && errs.length > 0) errs[errs.length - 1] += msg;
            }
        }
    } catch (e) {
        return { reply: "", error: `投递失败：${errText(e)}` };
    }
    const reply = [...texts.values()].join("\n").trim();
    if (!reply) {
        return { reply: "", error: errs.filter(Boolean).length > 0 ? `对方会话报错：${errs.join("；")}` : "对方这一轮没有产出文本" };
    }
    return { reply };
}

/** 落盘 + 返回（事件流的唯一写入口 —— 先落盘再 yield，断开不丢尾） */
function record(roomId: string, ev: RoomEvent): RoomEvent {
    appendEvent(roomId, ev);
    return ev;
}

/**
 * 发一条发言并投递。**逐条 yield 事件**（say → 各 agent 的 reply）——
 * RPC 侧把它当 serverStream 转发，UI 就能"发言一落盘就显示、回复一到就回显"。
 */
export async function* postToRoom(roomId: string, rawText: string): AsyncGenerator<RoomEvent> {
    const room = readRoom(roomId);
    if (!room) throw new Error(`房间不存在：${roomId}`);
    const text = rawText.trim();
    if (!text) throw new Error("空发言：没内容可发（UI/CLI 应提前拦）");

    const human = humanOf(room);
    const author = human?.id ?? "human:unknown";
    const fromName = human ? shortName(human.id) : "有人";

    // ── ① 解析收件人（判据 2：@X 覆盖 focus）──
    const addr = parseAddress(text);
    const explicit = addr.to ? [resolveMember(room, addr.to)] : [];
    const { recipients, routing } = resolveRecipients(explicit, room.focus);
    // 「人」不需要投递（他本来就在场，发言他自己看得见）—— 只有 agent 才要真起一轮
    const targets = recipients.filter((id) => deliverable(room.members.find((m) => m.id === id)));

    const sayEvent = record(roomId, {
        id: nextEventId(),
        ts: new Date().toISOString(),
        kind: "say",
        author,
        to: recipients,
        routing,
        text, // 存**原话**（含 @X）；投递时才剥
        delivered: recipients.length > 0,
        ...(recipients.length === 0
            ? { error: "没有 @ 收件人、也没有当前接受者（只有自己能看到）" }
            : {}),
    });
    yield sayEvent;

    if (targets.length === 0 && recipients.length > 0) {
        // 收件人全是人 / 或指向了不存在的成员：不投递，但如实说明（绝非静默）
        const why = recipients.every((id) => room.members.some((m) => m.id === id && m.kind === "human"))
            ? "收件人是人（在场即送达），无需投给 agent"
            : `收件人不是可投递成员：${recipients.join(" / ")}`;
        yield record(roomId, {
            id: nextEventId(),
            ts: new Date().toISOString(),
            kind: "say",
            author: author,
            to: recipients,
            routing,
            text: `（路由说明）${why}`,
            delivered: false,
            error: why,
        });
        return;
    }

    // ── ②③ 逐个投递并回收回复 ──
    const body = addr.to ? addr.text : text; // 投递正文剥掉 @X 前缀
    for (const id of targets) {
        const m = room.members.find((x) => x.id === id)!;
        const taskUri = m.backend!.type === "task" ? m.backend!.data.taskUri : "";
        const name = memberName(room, id);
        if (isBusy(taskUri)) {
            yield record(roomId, {
                id: nextEventId(),
                ts: new Date().toISOString(),
                kind: "reply",
                author: id,
                to: [author],
                text: "",
                delivered: false,
                error: `${name} 的会话正有轮次在跑，本切片不排队（未投递）`,
                sourceTask: taskUri,
            });
            continue;
        }
        const r = await runAndCollect(taskUri, deliveryText({ roomId, fromName, text: body }));
        yield record(roomId, {
            id: nextEventId(),
            ts: new Date().toISOString(),
            kind: "reply",
            author: id,
            to: [author],
            text: r.reply,
            delivered: !r.error,
            ...(r.error ? { error: r.error } : {}),
            sourceTask: taskUri,
        });
    }
}
