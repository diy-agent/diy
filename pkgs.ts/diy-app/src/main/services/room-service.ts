// src/main/services/room-service.ts — 多人房间的**投递器**（房间的心脏）
//
// 职责（##166 §28.5 A）：room 是「投递 + 汇总层」——
//   ① 收下一条发言 → 解析收件人（`@X` / `@all` 显式 · `focus` 隐式 · 都没有 = 只落盘）；
//   ② 对每个 agent 收件人，**在它自己的 task 会话里真起一轮**（复用 `LocalAgentManager.chat`，
//      不是本进程自导自演 —— 验收判据 3 的证据就在那个任务的 ops 流里）；
//   ③ 把它的回复**带署名**追加回房间事件流（判据 4）；
//   ④ 每个收件人一条**投递状态**（排队中 / 投递中 / 已投递 / 未投递），落 `deliveries.jsonl`。
//
// 四条实现口径：
//   · 投递文本走 `shared/room.deliveryText` 包装 —— agent 在**自己的会话**里看不到房间上下文，
//     "谁在说 / 从哪来"只能压进正文（wire 层身份只有正文有效，##166 §16.2）；
//   · 事件**先落盘再 yield**（与 local-agent 的 seal 同一条铁律：消费端断开不丢尾）；
//   · **同一成员串行、不同成员并行**（用户口径：消息对一个人是阻塞的）——
//     同一 member 的投递排在同一条 promise 链上（后面的停在 `queued`，**不丢、不合并**），
//     不同 member 各走各的链 ⇒ 「可以和 2 个 agent 同时说话」；
//   · 成员会话被**房间之外**的轮次占着时如实标「未投递 + 原因」（不静默、不硬塞插话队列，
//     后者是 §28.6 待决 73 的题）。

import { getLocalAgent } from "./local-agent";
import { sessionRegistry } from "./session-registry";
import { appendDelivery, appendEvent, ensureRoom, nextEventId, readRoom, setFocus, upsertMember } from "../core/room";
import { diyHome, getTask } from "../core/state";
import { defaultPersonaId, listPersonas } from "../core/persona";
import {
    DEFAULT_CHANNEL_ID,
    deliveryText,
    HUMAN_MEMBER_ID,
    MAIN_MEMBER_ID,
    isAllAddress,
    isSidebarRoomId,
    memberName,
    parseAddress,
    resolveMember,
    resolveRecipients,
    shortName,
    type DeliveryState,
    type DeliveryStatus,
    type Room,
    type RoomEvent,
    type RoomMember,
} from "../../shared/room";
import type { Op } from "./local-blocks";

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 人成员（「我」）—— 任务 room 与侧边栏 room 同一份（页面操作者本人，无 backend） */
function humanMember(): RoomMember {
    return { id: HUMAN_MEMBER_ID, name: "chen56", kind: "human", backend: null, role: "我" };
}

/**
 * 建一个**影子 task** —— 给"没有本任务可绑"的成员做会话底座（##166 §28.7 D 的 B 方案）。
 *
 * 两处调用，同一条规则（别再各写一份）：
 *   · `room.invite` —— 宿主是任务 room，影子 task 落它的 project；
 *   · `ensureSidebarRoom` —— 宿主不是 task（§30 侧边栏），回落到第一个可用 project。
 */
export async function createShadowTask(hostId: string, p: { id: string; name: string }): Promise<string> {
    // ⚠️ **必须动态 import**：顶层 import `core/task` 会把 `task-state`（`z.enum`）拖进共享 chunk，
    // 打包器让它先于 zod 补丁（`_cli-meta`）求值 ⇒ 启动即
    // `TypeError: TaskStateSchema.cliArg is not a function`（##322 实测过同型；我这一版就是踩了它）。
    const { createTask } = await import("../core/task");
    const { listProjects } = await import("../core/project");
    const host = getTask(hostId);
    const project = host?.project ?? listProjects()[0]?.id ?? "";
    if (!project) throw new Error("没有可用 project，建不了影子 task（先 diy project create）");
    return createTask({
        title: `[成员] ${p.name}`,
        project,
        persona: p.id,
        body: `影子任务：房间成员「${p.name}」的会话底座（##166 §28.7 D 的 B 方案）。\n\n宿主：${hostId}\n`,
    });
}

/**
 * 取（或补齐）**侧边栏 room** —— ##166 §30 的全局悬浮助手 room（id = `agent:room:ui/sidebar-<实例>`）。
 *
 * 与任务 room 的差别**只有一处**：它没有宿主 task ⇒ 主人格的 backend 无处可绑。
 * 口径（##166 §30 owner 补拍 · 选 a）：**主人格 = 缺省人物 + 影子 task** ——
 * 与被邀请成员**同一条规则**（不搞"主人格特例"）⇒ 成员表形态与任务 room 同构。
 *
 * ⚠️ 副作用（如实记）：**首次**调用会建一个影子 task（缺省人物的会话底座）。
 */
export async function ensureSidebarRoom(id: string): Promise<Room> {
    const home = diyHome();
    let room = readRoom(id);
    if (!room) {
        const personas = listPersonas(home);
        const personaId = defaultPersonaId(home);
        const p = personas.find((x) => x.id === personaId) ?? personas[0];
        const members: RoomMember[] = [humanMember()];
        if (p) {
            members.push({
                id: MAIN_MEMBER_ID,
                name: p.name,
                kind: "agent",
                main: true,
                persona: p.id,
                backend: { type: "task", data: { taskUri: await createShadowTask(id, p) } },
                role: "主人格",
            });
        }
        room = ensureRoom(id, {
            title: "侧边栏助手",
            members,
            focus: p ? MAIN_MEMBER_ID : null,
        });
    }
    if (!room.members.some((m) => m.kind === "human")) room = upsertMember(id, humanMember());
    return readRoom(id) ?? room;
}

/**
 * 取（或补齐）**一个任务的 room** —— 宿主定案（##166 §28.7 G）的唯一入口。
 *
 * 宿主定案：**room 就是任务对话页的状态**，id = taskUri；**每个任务恒是一个 room**
 * （不加人 = 成员表只有主人格）⇒ 单人任务与旧版行为一致，且**没有「单人/多人」两套分支**。
 *
 * 成员表恒有两条底：
 *   · `human:chen56` —— 页面操作者本人（发言恒是他）；
 *   · `agent:main`（`main: true`）—— **主人格**：`persona` = 任务的 persona（缺省则跟随缺省人物），
 *     `backend` = **本 task**（所以"投递给主人格"= 在本任务会话里起一轮，与旧版同一条通道）。
 *
 * 为什么在服务层而不是 core：这里要读 task 元数据（标题 / persona）与人物表 —— core 只管落盘那份。
 */
export async function ensureRoomForTask(taskUri: string): Promise<Room> {
    // 侧边栏 room（§30）没有宿主 task ⇒ 主人格的 backend 只能走影子 task（另一条 ensure 路径）
    if (isSidebarRoomId(taskUri)) return await ensureSidebarRoom(taskUri);
    const task = getTask(taskUri);
    const home = diyHome();
    const personaId = task?.persona?.trim() ? task.persona.trim() : defaultPersonaId(home);
    const personaName = listPersonas(home).find((p) => p.id === personaId)?.name;
    const main: RoomMember = {
        id: MAIN_MEMBER_ID,
        name: personaName ?? "主 agent",
        kind: "agent",
        main: true,
        ...(personaId ? { persona: personaId } : {}),
        backend: { type: "task", data: { taskUri } },
        role: "主人格",
    };
    const human = humanMember();
    let room = readRoom(taskUri);
    if (!room) {
        room = ensureRoom(taskUri, {
            ...(task?.title ? { title: task.title } : {}),
            members: [human, main],
            focus: MAIN_MEMBER_ID,
        });
    }
    // 补齐底成员（老房间 / 手改过成员表）：主人格与"我"恒在
    if (!room.members.some((m) => m.main)) room = upsertMember(taskUri, main);
    if (!room.members.some((m) => m.kind === "human")) room = upsertMember(taskUri, human);
    // 缺省接受者 = 主人格（不加人时"打字就是对本任务说"）
    if (!room.focus) room = setFocus(taskUri, MAIN_MEMBER_ID);
    return readRoom(taskUri) ?? room;
}

/** 该成员的会话此刻是不是有轮次在跑（判据：会话注册表，主进程内存权威） */
function isBusy(taskUri: string): boolean {
    return sessionRegistry.activeTurnList().some((t) => t.uri === taskUri);
}

/** 该成员能被投递吗（有 backend 的 agent）；不能的话给一句人话原因 */
function whyNotDeliverable(m: RoomMember | undefined): string | null {
    if (!m) return "房间里没有这个成员";
    if (m.kind !== "agent") return "收件人是人（在场即送达），无需投给 agent";
    if (m.backend?.type !== "task") return "该成员没有 backend（没有会话可投）";
    if (!m.backend.data.taskUri) return "该成员没绑任务（backend 为空）";
    return null;
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
 * `turnId` 一并带回（turn 块的 id）—— 判据 3 要拿它去那个任务的 ops 流里对账。
 */
async function runAndCollect(taskUri: string, text: string): Promise<{ reply: string; error?: string; turnId?: string }> {
    const agent = getLocalAgent();
    const texts = new Map<string, string>();
    const errs: string[] = [];
    let turnId: string | undefined;
    try {
        for await (const op of agent.chat(taskUri, text) as AsyncGenerator<Op>) {
            if (op.op === "start") {
                if (op.kind === "turn") turnId = op.id;
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
        return { reply: "", error: `投递失败：${errText(e)}`, ...(turnId ? { turnId } : {}) };
    }
    const reply = [...texts.values()].join("\n").trim();
    if (!reply) {
        return {
            reply: "",
            error: errs.filter(Boolean).length > 0 ? `对方会话报错：${errs.join("；")}` : "对方这一轮没有产出文本",
            ...(turnId ? { turnId } : {}),
        };
    }
    return { reply, ...(turnId ? { turnId } : {}) };
}

/**
 * 落盘 + 返回（事件流的**唯一写入口** —— 先落盘再 yield，断开不丢尾）。
 *
 * `channel` 在这里补（##166 §28.K ①）：本切片恒 `default`，调用方**不必逐处写** ——
 * 只有一条流 ⇒ 零分支；将来多流时改这一处（channel 由调用上下文决定）即可，
 * 而不是回头去补四个事件构造点。
 */
function record(roomId: string, ev: Omit<RoomEvent, "channel"> & { channel?: string }): RoomEvent {
    const rec: RoomEvent = { ...ev, channel: ev.channel ?? DEFAULT_CHANNEL_ID };
    appendEvent(roomId, rec);
    return rec;
}

// ─── 成员投递队列（**同一成员串行、不同成员并行**的唯一落点）─────────────

interface MemberQueue {
    /** 链尾：新投递接在它后面 */
    tail: Promise<unknown>;
    /** 链上还没跑完的条数（含正在跑的那条）—— >1 说明新的这条要排队 */
    depth: number;
}

const queues = new Map<string, MemberQueue>();

/** 队列里还有多少条没跑完（UI/CLI 想看"谁在排队"时用；0 = 空闲） */
export function memberQueueDepth(roomId: string, memberId: string): number {
    return queues.get(`${roomId}|${memberId}`)?.depth ?? 0;
}

/**
 * 发一条发言并投递。**逐条 yield 事件**（say → 各 agent 的 reply，按回复先后）——
 * RPC 侧把它当 serverStream 转发，UI 就能"发言一落盘就显示、谁的回复先到先回显"。
 */
export async function* postToRoom(roomId: string, rawText: string): AsyncGenerator<RoomEvent> {
    // roomId 自 §28.7 G 起就是 taskUri：取房间 = 取那个任务的 room（缺则补齐主人格成员）
    const room = await ensureRoomForTask(roomId);
    const text = rawText.trim();
    if (!text) throw new Error("空发言：没内容可发（UI/CLI 应提前拦）");

    const human = humanOf(room);
    const author = human?.id ?? "human:unknown";
    const fromName = human ? shortName(human.id) : "有人";

    // ── ① 解析收件人（判据 2：@X 覆盖 focus；@all = 全体 agent）──
    const addr = parseAddress(text);
    const explicit = addr.tos.map((t) => (isAllAddress(t) ? "all" : resolveMember(room, t)));
    const { recipients, routing } = resolveRecipients(explicit, room.focus, room.members);

    const sayId = nextEventId();
    // record = 落盘 + 补 channel（唯一写入口）；返回的那份才是盘上的形状 ⇒ yield 它
    const sayEvent = record(roomId, {
        id: sayId,
        ts: new Date().toISOString(),
        kind: "say",
        author,
        to: recipients,
        routing,
        text, // 存**原话**（含 @X）；投递时才剥
        delivered: false, // 读侧按投递状态 fold 真值（见 core/room.readRoomView）
        ...(recipients.length === 0 ? { error: "没有 @ 收件人、也没有当前接受者（只有自己能看到）" } : {}),
    });
    yield sayEvent;
    if (recipients.length === 0) return;

    // ── ②③④ 逐个投递（各自独立排队 / 并行）：状态变化 + 回复都**随流推** ──
    //
    // 两条通道：
    //   progress  —— 同一个 say id 的**状态快照**（排队中 → 投递中 → 已投递）。UI 按 id 覆盖渲染，
    //                这样"排队"是**看得见**的实时状态，不用等下一次轮询；
    //   completed —— 一条实打实的回复（每个收件人恰好一条）。
    const body = addr.tos.length > 0 ? addr.text : text; // 投递正文剥掉 @X 前缀
    const toAll = routing === "all";
    const progress: RoomEvent[] = [];
    const completed: RoomEvent[] = [];
    let wake: (() => void) | null = null;
    const poke = (): void => {
        wake?.();
        wake = null;
    };
    const states = new Map<string, DeliveryState>();
    /** 状态一落盘就顺手推一份 say 的快照（含本条目前所有收件人的状态） */
    const markState = (st: DeliveryState): void => {
        states.set(st.memberId, st);
        progress.push({ ...sayEvent, deliveries: [...states.values()] });
        poke();
    };

    // 不可投递的收件人（人 / 成员不存在 / 没 backend）：先如实记状态 + 记说明事件，**不静默**
    const immediate: RoomEvent[] = [];
    const tasks: Promise<void>[] = [];
    for (const id of recipients) {
        const m = room.members.find((x) => x.id === id);
        const why = whyNotDeliverable(m);
        if (why) {
            const replyId = nextEventId();
            const skip = record(roomId, {
                id: replyId,
                ts: new Date().toISOString(),
                kind: "reply",
                author: id,
                to: [author],
                text: "",
                delivered: false,
                error: why,
                ...(m?.backend?.type === "task" && m.backend.data.taskUri ? { sourceTask: m.backend.data.taskUri } : {}),
            });
            const st: DeliveryState = {
                memberId: id,
                status: "skipped",
                error: why,
                replyId,
                ts: new Date().toISOString(),
            };
            appendDelivery(roomId, { eventId: sayId, ...st });
            states.set(id, st);
            immediate.push({ ...sayEvent, deliveries: [...states.values()] }, skip);
            continue;
        }
        tasks.push(deliverOne({ roomId, room, sayId, member: m!, author, fromName, body, toAll, markState, done: (ev) => {
            completed.push(ev);
            poke();
        } }));
    }
    for (const ev of immediate) yield ev;

    for (let finished = 0; finished < tasks.length; ) {
        while (progress.length === 0 && completed.length === 0) await new Promise<void>((res) => (wake = res));
        while (progress.length > 0) yield progress.shift()!;
        if (completed.length > 0) {
            yield completed.shift()!;
            finished++;
        }
    }
    while (progress.length > 0) yield progress.shift()!;
}

interface DeliverInput {
    roomId: string;
    room: Room;
    sayId: string;
    member: RoomMember;
    author: string;
    fromName: string;
    body: string;
    toAll: boolean;
    /** 记一条投递状态（落盘 + 随流推快照） */
    markState: (st: DeliveryState) => void;
    /** 完成（一条回复事件） */
    done: (ev: RoomEvent) => void;
}

/**
 * 投给一个成员：入队 → 跑 → 落回复 + 状态。
 *
 * **串行的落点**：同一个 `(roomId, memberId)` 的调用接在前一条的链尾（`st.tail`）——
 * 前一条没跑完，这一条就先标 `queued` 停在那儿（人看得见"排队中"，不是石沉大海）。
 * 链的 key 带 roomId：同一成员在**不同房间**里是两条独立链（房间之间不该互相阻塞）。
 */
function deliverOne(input: DeliverInput): Promise<void> {
    const { roomId, member, sayId, body, fromName, author, toAll } = input;
    const taskUri = member.backend!.type === "task" ? member.backend!.data.taskUri : "";
    const key = `${roomId}|${member.id}`;
    const st = queues.get(key) ?? { tail: Promise.resolve(), depth: 0 };
    queues.set(key, st);
    st.depth++;
    const ahead = st.depth - 1;

    const mark = (status: DeliveryStatus, extra: Record<string, unknown> = {}): void => {
        const st: DeliveryState = {
            memberId: member.id,
            status,
            taskUri,
            ts: new Date().toISOString(),
            ...extra,
        } as DeliveryState;
        appendDelivery(roomId, { eventId: sayId, ...st });
        input.markState(st);
    };
    mark("queued", ahead > 0 ? { error: `前面还有 ${ahead} 条在排队（本切片的队列只在内存里，重启即丢）` } : {});

    const run = async (): Promise<void> => {
        st.depth--;
        mark("running");
        const name = memberName(input.room, member.id);
        if (isBusy(taskUri)) {
            // 房间之外的轮次占着这个会话（别的客户端在跑 / 上一条异常没清）：如实标未投递，不硬塞
            const replyId = nextEventId();
            const ev = record(roomId, {
                id: replyId,
                ts: new Date().toISOString(),
                kind: "reply",
                author: member.id,
                to: [author],
                text: "",
                delivered: false,
                error: `${name} 的会话正有轮次在跑（不是本房间的），本次未投递`,
                sourceTask: taskUri,
            });
            mark("failed", { error: `${name} 的会话忙`, replyId });
            input.done(ev);
            return;
        }
        // 主人格（`main`）的会话 = **宿主任务自己的会话** ⇒ 正文就是原话，不包房间前缀
        // （##166 §28.7 G 推论 4：「不加人时行为与旧版完全一致」的正文层落点）。
        const r = await runAndCollect(
            taskUri,
            deliveryText({ roomId, fromName, text: body, toAll, plain: member.main === true }),
        );
        const replyId = nextEventId();
        const ev = record(roomId, {
            id: replyId,
            ts: new Date().toISOString(),
            kind: "reply",
            author: member.id,
            to: [author],
            text: r.reply,
            delivered: !r.error,
            ...(r.error ? { error: r.error } : {}),
            sourceTask: taskUri,
            // 这一轮的引用（##166 §28.7 A1）：UI 据此去成员会话切出该轮 → 复用任务对话的块渲染
            ...(r.turnId ? { ref: { memberUri: member.id, turnId: r.turnId } } : {}),
        });
        mark(r.error ? "failed" : "ok", {
            replyId,
            ...(r.turnId ? { turnId: r.turnId } : {}),
            ...(r.error ? { error: r.error } : {}),
        });
        input.done(ev);
    };

    const started = st.tail.then(run, run); // 前一条失败也照跑（队列不是"一个失败全停"）
    st.tail = started.catch(() => undefined);
    return started;
}
