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
//   · 成员会话**正有轮次在跑**（本房间的 / 任务页自己那一轮 / 别的客户端）时，这条投递
//     **插进正在跑的那一轮**（`deliveryPlanFor` ⇒ `steer`，下一步生效），状态记 `ok` + 一句
//     `note` 说明"为什么没有独立回复"。**不再**标「未投递」—— 那与任务页按 Enter 的插话
//     行为自相矛盾，且会丢掉"agent 正在做错事时立刻纠正"的能力（##377 第 27 刀）。
//   · 入队**只保证"记下来"**（`steerAdd` 不开轮，##303）⇒ 入队后必须**复判**一次：轮次恰好
//     在收尾时没有人会来认领，立刻用队列内容醒来一轮（`steerOrWake`）。`ok` 的判据是
//     「入队 且（仍在跑 或 已唤醒）」，不是"入队了"（##266 review1 R1）。

import { getLocalAgent } from "./local-agent";
import { sessionRegistry } from "./session-registry";
import {
    advanceLastSeen,
    appendDelivery,
    appendEvent,
    ensureRoom,
    nextEventId,
    readEvents,
    readRoom,
    setFocus,
    upsertMember,
} from "../core/room";
import { diyHome, getTask } from "../core/state";
import { defaultPersonaId, listPersonas } from "../core/persona";
import { DEFAULT_STEER_MODE } from "../../shared/steer-mode";
import {
    DEFAULT_CHANNEL_ID,
    deliveryPlanFor,
    deliveryText,
    HUMAN_MEMBER_ID,
    MAIN_MEMBER_ID,
    isAllAddress,
    isSidebarRoomId,
    memberName,
    deliveryOriginFor,
    opsOriginFor,
    parseAddress,
    resolveMember,
    memberOptions,
    mirrorEvents,
    mirrorMissingParts,
    resolveRecipients,
    shouldMirrorRoom,
    shortName,
    type DeliveryState,
    type DeliveryStatus,
    type Room,
    type RoomEvent,
    type RoomMember,
    type TurnOrigin,
} from "../../shared/room";
import type { Op } from "./local-blocks";
import { errText } from "../../shared/error-report";
import { reportError } from "./error-report";

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

/**
 * 把「这句」与「这一轮的回复」**写回接收方自己的房间**（##377 第 24 刀 · 双向可见）。
 *
 * 为什么必须做：投递过去只记在**源房间**的事件流里 ⇒ 接收方房间 `room get <它>` 恒为 0 事件，
 * 切过去什么都没有（用户原话「不能真正使用」里最硬的一条）。
 *
 * 三条口径：
 *   ① **判据在 `shared/room`（纯函数 + 单测）**，这里只做「读写盘」；
 *   ② **同一房间不写回**（任务页对主人格自己说话 = 本来就在一条流里，写了就是重复）；
 *   ③ **幂等按「每条」算**（review2 R1）：`say` / `reply` 是两次 append，崩在两次之间会留下
 *      「有 say 无 reply」—— 只看 say 就整体 return 的话那条 reply **永远补不回来**。
 *      判据在 `shared/room.mirrorMissingParts`（纯函数 + 单测）：**缺哪条补哪条**；
 *   ④ **永不传染投递**：任何异常只吞掉（与「水位是优化」同一条口径，P1 的教训）。
 */
async function mirrorIntoTarget(input: {
    sourceRoomId: string;
    sayId: string;
    targetTaskUri: string;
    author: string;
    text: string;
    /** 缺省 = 没有属于这条投递的回复（忙时插进正在跑的轮次，见 `deliveryPlanFor`） */
    replyText?: string;
    turnId?: string;
    error?: string;
}): Promise<void> {
    try {
        if (!shouldMirrorRoom(input.sourceRoomId, input.targetTaskUri)) return;
        const target = await ensureRoomForTask(input.targetTaskUri);
        // 目标房间里「拥有那个会话」的成员 = 主人格（会话按 task 唯一 ⇒ 一轮跑在哪个 task，就归哪个房间的主人格）
        const owner =
            target.members.find((m) => m.main === true && m.backend?.type === "task" && m.backend.data.taskUri === input.targetTaskUri) ??
            target.members.find((m) => m.main === true);
        const targetMemberId = owner?.id ?? MAIN_MEMBER_ID;
        // 幂等（review2 R1）：判据是「两条**各自**在不在」，不是「say 在」——
        // 补写比漏写安全（与「水位是优化」同族）：重复写没有意义，少一条就是永久缺一块。
        const { events } = readEvents(input.targetTaskUri);
        const miss = mirrorMissingParts(events, input.sayId);
        if (!miss.say && !miss.reply) return;
        const built = mirrorEvents({
            origin: { roomId: input.sourceRoomId, sayId: input.sayId },
            targetRoomId: input.targetTaskUri,
            targetMemberId,
            author: input.author,
            text: input.text,
            replyText: input.replyText,
            taskUri: input.targetTaskUri,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            ...(input.error ? { error: input.error } : {}),
            ids: { say: nextEventId(), reply: nextEventId() },
            ts: new Date().toISOString(),
        });
        if (!built) return;
        // 只补缺的那条（`mirrorMissingParts` 的判据）—— 两条都在时上面已 return
        if (miss.say) record(input.targetTaskUri, built.say);
        // `built.reply` 缺席 = 这条投递本来就没有独立回复（忙时插话）⇒ 不去"补"
        if (miss.reply && built.reply) record(input.targetTaskUri, built.reply);
    } catch (e) {
        // 出口落盘（##411）：这里原来只是 console.warn —— 跨房间镜像写不进去的事实随时间丢失。
        // 只用 catch 作用域内可拿到的入参（`targetMemberId` 在 try 里算的，这里不能引）。
        reportError(e, { where: "room/mirror-write-back", sourceRoomId: input.sourceRoomId, taskUri: input.targetTaskUri });
        console.warn(`[room] 写回接收方房间失败（不影响投递）：${errText(e)}`);
    }
}

/**
 * 该成员的会话此刻是不是有轮次在跑（判据：会话注册表，主进程内存权威）。
 *
 * 它现在只决定**投递方式**（开一轮 / 插进正在跑的那一轮，见 `deliveryPlanFor`），
 * 不再决定"能不能投"。
 */
function isBusy(taskUri: string): boolean {
    return sessionRegistry.activeTurnList().some((t) => t.uri === taskUri);
}

/**
 * `steerOrWake` 的两种结局：真插进了正在跑的一轮 / 醒来了一轮（这条作它的开场）。
 *
 * `steer` 带上队列项 id（##377 第 29 刀）：投递状态里留这个键，读侧才能反查
 * 「这句话被哪一轮消化了」（`local-agent.steerTurnId`），从而把 say 指到那一轮的回复。
 */
export type SteerOutcome = { kind: "steer"; steerId?: string } | { kind: "wake"; r: RunResult };

/**
 * 忙时投递：**先入队，再复判**（##266 review1 R1）。
 *
 * 为什么入队后必须复判 —— 入队本身**不开轮**（`local-agent.steerAdd` 头注、##303）：
 * 一条插话只有两个被取走的时机，**下一步之前**（`claimStepSteers`）或**轮末续轮的开场**
 * （`chat()` 的续轮循环「轮末整批取走」）。轮次恰好在收尾时（续轮已取完队列 / 撞续轮上限 /
 * `turns` 注销前那段窗口），这两个时机都不会再发生 ⇒ 那条话永远躺在 `drafts.yaml` 里，
 * 而我们已经对外报了「已投递」。这正是本刀要消灭的那句假话（换了个位置）。
 *
 * 判据（写进注释钉死，别再漂）：**`ok` = 入队 且（仍在跑 或 已唤醒）**。
 *
 * `deps.busy` 的语义是「**队列还会不会有人来取走它**」—— 传 `agent.busy`（`chat()` 的互斥守卫
 * 与轮末续轮用的同一张 `turns` 表），不是 `isBusy`（会话注册表的"正在生成"）：`runTurn` 收尾就
 * 清了注册表的 turn，而"轮末整批取走"的续轮循环在那之后 —— 拿注册表判会把那段窗口误判成
 * "没人取"。
 *
 * `deps` 可注入：复判那一刻「轮次刚收尾」是竞态，测试只能靠脚本化探针构造那一瞬
 * （见 `tests/core/room-busy-steer.test.ts`）。
 */
export async function steerOrWake(
    taskUri: string,
    text: string,
    author: string | undefined,
    deps: {
        /** 返回入队后的队列快照（生产 = `local-agent.steerAdd`，末项即本次新增的那条） */
        steerAdd: (
            taskUri: string,
            mode: typeof DEFAULT_STEER_MODE,
            text: string,
            author?: string,
        ) => readonly { id: string }[];
        busy: (taskUri: string) => boolean;
        runQueued: (taskUri: string) => Promise<RunResult>;
    },
): Promise<SteerOutcome> {
    // 入队（FIFO 尾部 ⇒ 末项就是本次新增的那条）。它的 id 一路带回去：
    // 投递状态里存 `steerId`，读侧据此反查「这句话被哪一轮消化了」（第 29 刀）。
    const items = deps.steerAdd(taskUri, DEFAULT_STEER_MODE, text, author);
    const steerId = items[items.length - 1]?.id;
    // 仍有人在跑 ⇒ 下一步必来认领（或轮末续轮带走）：插进那一轮，**没有属于这条的独立回复**。
    if (deps.busy(taskUri)) return steerId ? { kind: "steer", steerId } : { kind: "steer" };
    // 已经没人跑了 ⇒ 用**队列现有内容**开一轮（##303 的 c 方案：留言本就是"发一句话"）。
    // 队列里若有别的待投递项，一并作开场（轮末整批取走是同一个口径）。
    const r = await deps.runQueued(taskUri);
    // 竞态：复判之后、开轮之前别人起了轮（`chat` 的互斥守卫拒发）⇒ 这条**安好在队列里**，
    // 由那一轮带走。不能反手报「投递失败」（它没失败），如实回到 steer 口径。
    if (r.error && deps.busy(taskUri)) return steerId ? { kind: "steer", steerId } : { kind: "steer" };
    return { kind: "wake", r };
}

/** 该成员能被投递吗（有 backend 的 agent）；不能的话给一句人话原因 */
function whyNotDeliverable(m: RoomMember | undefined, room: Pick<Room, "members">): string | null {
    if (!m) {
        // 打错名字是最常见的一类（成员在界面上显示**人物名**，凭直觉打的短名未必命中）⇒ 直接给可选名
        // 候选清单走 `memberOptions`（一处真源，与 UI 提示同一份 —— ##377 review3 R1）
        const names = memberOptions(room);
        return names.length > 0
            ? `房间里没有这个成员（可选：${names.join(" / ")}）`
            : "房间里没有这个成员";
    }
    if (m.kind !== "agent") return "收件人是人（在场即送达），无需投给 agent";
    if (m.backend?.type !== "task") return "该成员没有 backend（没有会话可投）";
    if (!m.backend.data.taskUri) return "该成员没绑任务（backend 为空）";
    return null;
}

/** 房间里的「人」（发消息的默认主体；最小切片一人一房） */
function humanOf(room: Room): RoomMember | undefined {
    return room.members.find((m) => m.kind === "human");
}

/** 一轮的收获：回复正文 + 失败原因 + 那一轮的 turnId（判据 3 的对外键） */
export interface RunResult {
    reply: string;
    error?: string;
    turnId?: string;
}

/**
 * 跑一轮并把 assistant 文本收成一条回复（**任意一种开轮方式**）。
 *
 * 只收 `start.meta.role !== "user"` 的 text 块：开场 user 块同样是 text 块（##310 起两者同形），
 * 混进去会让"回复"里带上自己刚说的话（自问自答的假象）。
 * `turnId` 一并带回（turn 块的 id）—— 判据 3 要拿它去那个任务的 ops 流里对账。
 *
 * 抽成一层的原因（##377 第 27 刀 R1）：开轮方式现在有两种 —— 投递一条新消息（`chat`）、
 * 用**队列现有内容**开一轮（`chatQueued`，##303 的 c 方案），而"这一轮说了什么"的判据
 * 一模一样。两条各自实现一份，下一次改「什么算回复」就会漏掉一边。
 *
 * 导出（##411）：投递失败落盘（`reportError`）就钉在它的 catch 里，验收要**真链路**跑这条分支
 * （桩一个抛错的 run 生成器），所以这里不再私有。
 */
export async function collectTurn(run: () => AsyncGenerator<Op>): Promise<RunResult> {
    const texts = new Map<string, string>();
    const errs: string[] = [];
    let turnId: string | undefined;
    try {
        for await (const op of run()) {
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
        // 出口落盘（##411）：投递失败是**最黑的一口箱子** —— 用户只看到「投递失败：xxx」，
        // 而 ops 流里根本没有这一条（异常在 collectTurn 里就被吃掉转成字符串了）。
        reportError(e, { where: "room/deliver", turnId });
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

async function runAndCollect(
    taskUri: string,
    text: string,
    /**
     * 随附事实（第 23 刀把原来的 `author` 字符串收成 `TurnOrigin`）——
     * 落进对方会话那条 user 块的 `meta.author` / `meta.room`。
     */
    origin?: TurnOrigin,
): Promise<RunResult> {
    return collectTurn(
        // 位次（##266 review1 R3.2）：① taskUri ② text ③ model ④ reasoningEffort ⑤ signal
        // ⑥ seed ⑦ origin —— 中间四个 `undefined` 依次是"按任务绑定的人物解析 / 不开信号 / 不用 seed"。
        () => getLocalAgent().chat(taskUri, text, undefined, undefined, undefined, undefined, origin) as AsyncGenerator<Op>,
    );
}

/** 用**队列现有内容**开一轮（不新增入队；队列空则不产任何 op）—— R1 的唤醒落点。 */
async function runQueued(taskUri: string): Promise<RunResult> {
    return collectTurn(() => getLocalAgent().chatQueued(taskUri));
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
    // `self = author`（##166 §38.2）：`@` 自己 = **笔记**（零投递），不是投递、也不是故障。
    const addr = parseAddress(text);
    const explicit = addr.tos.map((t) => (isAllAddress(t) ? "all" : resolveMember(room, t)));
    const { recipients, routing } = resolveRecipients(explicit, room.focus, room.members, author);

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
        // ⚠️ 零收件人**不再报 error**（##166 §38.2）：那可能是**笔记**（routing:'note'，正常操作），
        //    也可能是**打错名字**（`unknown-recipient`）—— 后者由 `whyNotDeliverable` 在投递环节
        //    如实报出（它才是真故障）。把两者混成一个 error 字段 = 让人不敢写笔记。
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
    /** 已办完的收件人数（≠ 已产出的回复数：忙时插话没有独立回复，但也要算办完） */
    let finished = 0;
    for (const id of recipients) {
        const m = room.members.find((x) => x.id === id);
        const why = whyNotDeliverable(m, room);
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
            // 完成信号与回复事件分开计数（##377 第 27 刀）：忙时插进正在跑的那一轮 ⇒
            // 这条投递**没有**属于自己的回复，但"办完了"必须算数，否则流永远不关闭。
            if (ev) completed.push(ev);
            finished++;
            poke();
        } }));
    }
    for (const ev of immediate) yield ev;

    // 逐条推（状态快照与回复按到达顺序），**收尾判据 = 每个收件人都发了完成信号** ——
    // 不是"每个收件人都产出了一条回复"（`done()` 不带事件也算办完）。
    for (;;) {
        if (progress.length > 0) {
            yield progress.shift()!;
            continue;
        }
        if (completed.length > 0) {
            yield completed.shift()!;
            continue;
        }
        if (finished >= tasks.length) break;
        await new Promise<void>((res) => (wake = res));
    }
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
    /**
     * 完成。**`ev` 缺省 = 这条投递没有属于自己的回复事件**（忙时插进了正在跑的那一轮）。
     *
     * ⚠️ 完成信号与回复事件是两件事（##377 第 27 刀）：`postToRoom` 的收尾只等"每个收件人
     * 都发了完成信号"，别把计数绑在"产出了一条 reply"上 —— 否则没有回复的那条会让整条流
     * 永远等下去（P1 那个挂死的同型故障）。
     */
    done: (ev?: RoomEvent) => void;
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

    /**
     * 一轮跑完的收尾：落回复事件 + 投递状态 + 水位 + 双向可见 + 完成信号。
     *
     * **两条路径共用**（##377 第 27 刀 R1）：空闲开一轮、以及"轮次恰好在收尾 ⇒ 用队列内容醒来
     * 一轮"—— 它们都是"真的跑了一轮、有属于这条的回复"，收尾口径必须逐字相同。
     */
    const settleTurn = async (r: RunResult): Promise<void> => {
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
        // 水位前移（##166 §44.6 四.1）：**只在真跑完时**前移 —— 失败不前移，下次投递时这段时间
        // 别人的话还能补给它（宁可重复一轮，不可静默漏掉）。
        // ⚠ 「会话忙」自第 27 刀起已不是本函数的路径（忙 ⇒ 插进那一轮，见上方 steer 分支；
        //   入队后还复判过一次，见 `steerOrWake`）—— 别把这两处的注释读成互相打脸。
        if (!r.error) await advanceLastSeen(roomId, { [member.id]: sayId });
        // 双向可见（第 24 刀）：**成轮之后**才写回 —— 失败的投递不该在接收方房间留下一条「说过的话」。
        // 放在 `done` 之前：写回失败也不影响完成信号（函数内部全吞，见 mirrorIntoTarget ④）。
        if (!r.error) {
            await mirrorIntoTarget({
                sourceRoomId: roomId,
                sayId,
                targetTaskUri: taskUri,
                author,
                text: body,
                replyText: r.reply,
                ...(r.turnId ? { turnId: r.turnId } : {}),
            });
        }
        input.done(ev);
    };

    const run = async (): Promise<void> => {
        st.depth--;
        mark("running");
        const name = memberName(input.room, member.id);
        // ── 忙时投递 = **插进正在跑的那一轮**（##377 第 27 刀）────────────────────────
        // 修前：会话正有轮次在跑（任务页自己那一轮 / 别的客户端 / 侧边栏那条链）⇒ 直接标
        //   「未投递」—— 而任务页同一句话按 Enter 会进**插话队列**（`_su*` 块），两个入口
        //   对"忙"给出两种答案，且插话那条**不落 room**（房间页 / `room get` 里查不到）。
        // 修后（`deliveryPlanFor` 的判据）：**每句话都先落 room**（本轮 `say` 已经在流里），
        //   忙不忙只决定投递方式 —— 空闲开一轮（能拿到属于这条消息的回复）、忙则插进那一轮
        //   （下一步生效，回复属于它）。插话能力**不能丢**：agent 正在做错事时，用户的纠正
        //   不该等到三分钟后。
        const plan = deliveryPlanFor(isBusy(taskUri));
        if (plan.kind === "steer") {
            const origin = opsOriginFor(member.main === true, author, { roomId, sayId });
            // 正文与开一轮那条**同一份**（`deliveryText`）：agent 在自己的会话里看不到房间，
            // "谁在说 / 从哪来"只能压进正文（wire 层身份只有正文有效，##166 §16.2）。
            const steered = await steerOrWake(
                taskUri,
                deliveryText({ roomId, fromName, text: body, toAll, plain: member.main === true }),
                origin.author,
                {
                    steerAdd: (u, mode, t, a) => getLocalAgent().steerAdd(u, mode, t, a),
                    // 复判的判据不是 `isBusy`（注册表的"正在生成"），而是 `agent.busy`（`chat()` 的
                    // 互斥守卫 + 轮末续轮用的是**同一张** `turns` 表）—— 这里问的是"队列还会不会有人
                    // 来取走它"。两者在轮末有一段必然分岔：`runTurn` 收尾就把注册表的 turn 清了，
                    // 而续轮循环（"轮末整批取走"）在那之后才决定要不要再开一轮 ⇒ 拿 `isBusy` 判，
                    // 这段窗口里会误判"没人取"并去叫醒（叫不醒，反被判失败）。
                    busy: (u) => getLocalAgent().busy(u),
                    runQueued,
                },
            );
            if (steered.kind === "steer") {
                // `steerId` 落盘（第 29 刀）：这条投递**没有自己的回复**，但"它进了哪一轮"是可查的事实
                // —— `room.get` 的读侧投影拿它反查 turnId（`local-agent.steerTurnId`），
                // 于是房间页能把这条 say 指到"回复在你上面那一轮"（body 真缺陷第 1 条）。
                mark("ok", { note: plan.note, ...(steered.steerId ? { steerId: steered.steerId } : {}) });
                // 水位照常前移：这句话**确实送到了**（进了那一轮的插话队列，且有人在跑 ⇒
                // 下一步 / 轮末续轮必来取走）⇒ 下一轮的房间上下文不该再把它当"没看过的新发言"
                // 重投一遍（与"失败不前移"不冲突：失败是没送到）。
                await advanceLastSeen(roomId, { [member.id]: sayId });
                // 双向可见（第 24 刀）：写回只带 `say` —— 这条投递**没有自己的回复**（它在
                // 正在跑的那一轮里被消化），写一条空回复反而会造出"说了话、没人回"的假象。
                await mirrorIntoTarget({
                    sourceRoomId: roomId,
                    sayId,
                    targetTaskUri: taskUri,
                    author,
                    text: body,
                });
                console.log(`[room] ${name} 的会话正忙 ⇒ 这条插进正在跑的一轮（room ${roomId}）`);
                input.done();
                return;
            }
            // 复判发现**轮次已收尾**（那一瞬没有任何人会来取走这条）⇒ 已用队列内容醒来一轮：
            // 这条从"没人认领"变成"真开了一轮"，于是它和空闲路径一样有回复、有 turnId。
            // 收尾走**同一个** `settleTurn`（记录 reply / 水位 / 双向可见只有一份）。
            console.log(`[room] ${name} 的轮次在收尾 ⇒ 用队列内容醒来一轮（room ${roomId}）`);
            await settleTurn(steered.r);
            return;
        }
        // 正文**只留人话**（##377 第 26 刀）：房间近期发言改走 `runtime.room.recent`
        // （结构化变量单元，由 `local-agent` 在轮首装配），不再拼进这条 user 块。
        // 拼在正文里的代价：① 进会话史即永留（压缩模型会把它当人话改写、回放分不清谁说的）；
        // ② 与"投递这条 say 本身"混在一处，正文与机制文本不可区分。
        //
        // 看哪间房由 `driveTurn` 从 `origin.room.roomId`（= 本房间）+ `sayId` 推出来 ——
        // 水位仍归这里（投递成功后按 `sayId` 前移，与投递状态同生共死；见下方 `advanceLastSeen`）。
        //
        // 主人格（`main`）的会话 = **宿主任务自己的会话** ⇒ 正文就是原话，不包房间前缀
        // （##166 §28.7 G 推论 4：「不加人时行为与旧版完全一致」的正文层落点）。
        const r = await runAndCollect(
            taskUri,
            deliveryText({
                roomId,
                fromName,
                text: body,
                toAll,
                plain: member.main === true,
            }),
            // 署名（##166 §40 B）+ 房间来源（第 23 刀）：落进那条 user 块的 `meta.author` / `meta.room`。
            // ⚠ 第 17 刀收窄（§44.2 A · 判据 1/7）：**投给主人格且发起者是页面操作者本人 ⇒ 整条不落**
            //   （不署名、也不带 `room`）—— 否则气泡翻边 + 多出「房间投递」标记，与"与今天等价"冲突。
            //   判据在 `shared/room.deliveryOriginFor`（纯函数 + 单测），**别在这里另写一份**。
            //   `fromDelivery: true` 仍恒带（不落盘）：它表达「这一轮是投递」，与"落盘落什么"是两件事。
            deliveryOriginFor(member.main === true, author, { roomId, sayId }),
        );
        await settleTurn(r);
    };

    // ⚠️ **`input.done` 是这条链的不变量**（owner review P1）：`post` 的收尾循环是
    // `for (let finished = 0; finished < tasks.length;)`，只靠 `completed` 计数收敛，而 `completed`
    // 的**唯一**来源就是 `input.done`。所以 `run` 里任何一步抛错（`runAndCollect` / `record` /
    // `mark` / `advanceLastSeen` / 未来的任何 await）都必须在这里兜住并**补一次 done** ——
    // 否则那条 `room.post` 的 serverStream 永远不关闭（症状 = CLI/UI 挂住，不是报错）。
    const started = st.tail
        .then(run, run) // 前一条失败也照跑（队列不是"一个失败全停"）
        .catch((e: unknown) => {
            // 出口落盘（##411）：链上任何一步抛错都在这里收敛成一条房间事件 —— 事件里只有一句话，
            // 现场（stack / code）只能靠这里留下（`String(e)` 连 name 都不一定给）。
            reportError(e, { where: "room/delivery-chain", roomId, member: member.id, taskUri });
            const msg = `投递异常：${errText(e)}`;
            // 落盘也可能失败（ENOSPC / 目录被删）—— 但**完成信号不能依赖落盘**：
            // 事件写不进去就给一条内存事件，至少让流收尾、让 UI 看见失败。
            let ev: RoomEvent | undefined;
            try {
                ev = record(roomId, {
                    id: nextEventId(),
                    ts: new Date().toISOString(),
                    kind: "reply",
                    author: member.id,
                    to: [author],
                    text: "",
                    delivered: false,
                    error: msg,
                    ...(taskUri ? { sourceTask: taskUri } : {}),
                });
            } catch {
                ev = undefined;
            }
            try {
                mark("failed", { error: msg, ...(ev ? { replyId: ev.id } : {}) });
            } catch {
                // appendDelivery 也失败：状态徽章少一条，但仍不能堵死流
            }
            input.done(
                ev ?? {
                    id: nextEventId(),
                    ts: new Date().toISOString(),
                    // 盘写都失败时的**内存事件**：`room.post` 的流照样能收尾、UI 照样看得见失败
                    channel: DEFAULT_CHANNEL_ID,
                    kind: "reply",
                    author: member.id,
                    to: [author],
                    text: "",
                    delivered: false,
                    error: msg,
                    ...(taskUri ? { sourceTask: taskUri } : {}),
                },
            );
        });
    st.tail = started.catch(() => undefined);
    return started;
}
