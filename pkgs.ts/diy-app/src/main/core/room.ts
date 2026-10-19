// src/main/core/room.ts — 多人房间的**落盘层**（文件布局 + 读写）
//
// 落位（##166 §28.6 待决 74 的探索期取值）：`$DIY_HOME/rooms/<roomId>/`
//   room.yaml        成员表 + focus —— **领域真源**（丢了 = 谁在房间里、在跟谁说话全没了）
//   events.jsonl     事件流（append-only）—— **汇总层的正文**（人说的话 + agent 的回复）
//   deliveries.jsonl 投递状态快照（append-only，每行一个 (eventId, memberId) 的状态）——
//                    **事件本体仍只增不改**：状态变化不改写 events.jsonl，而是往这里追加一行，
//                    读侧按 (eventId, memberId) 取最后一行 fold 成当前状态（`readRoomView`）。
//
// 为什么在 `rooms/` 而不是任务的 `local/`：room ≠ session（§28.5 A 连带结论 1）——
// 一个房间可横跨多个成员的会话，塞进任一成员的会话目录都是"把汇总层寄存在某一个成员家里"。
// `rule.core-log` 的约束：成员表（room.yaml）自成真源、可独立读写；events.jsonl 只被
// 投递器**追加**、被 UI 读，丢了不影响任何成员的会话运行（可清、可重建场景见日志）。
//
// ⚠️ 不写 `state.yaml`：那是运行中的应用独占写入的核心状态（data.state 约定），外部写它
//    等于与运行中的 app 抢同一份文件（与 flow-store 同一条理由）。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import * as yaml from "js-yaml";
import { diyHome } from "./state";
import {
    isValidRoomId,
    defaultChannels,
    DEFAULT_CHANNEL_ID,
    DeliveryStateSchema,
    RoomEventSchema,
    RoomSchema,
    type DeliveryState,
    type Room,
    type RoomChannel,
    type RoomEvent,
    type RoomMember,
} from "../../shared/room";

/** 房间根目录（`$DIY_HOME/rooms`） */
export function roomsRoot(): string {
    return join(diyHome(), "rooms");
}

export function roomDir(id: string): string {
    return join(roomsRoot(), id);
}

export function roomYamlPath(id: string): string {
    return join(roomDir(id), "room.yaml");
}

export function roomEventsPath(id: string): string {
    return join(roomDir(id), "events.jsonl");
}

/** 读房间。不存在 / 解析失败 → null（调用方决定是"没建过"还是"坏了"） */
export function readRoom(id: string): Room | null {
    if (!isValidRoomId(id)) return null;
    const f = roomYamlPath(id);
    if (!existsSync(f)) return null;
    let raw: unknown;
    try {
        raw = yaml.load(readFileSync(f, "utf8"));
    } catch {
        return null;
    }
    const parsed = RoomSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/** 原子写：成员表是丢不起的数据，不做"半个文件" —— 原语收敛到 `core/atomic-write.ts`（##382） */
export function writeRoom(room: Room): void {
    const f = roomYamlPath(room.id);
    const next: Room = {
        ...room,
        // channel 表**恒有 `default`**（##166 §28.K ①）：老房间（占位符之前建的）与手改过的
        // room.yaml 都可能没有这个键 —— 写回时补齐，别让"缺 channel"变成一种状态。
        channels: room.channels?.length ? room.channels : defaultChannels(),
        updated: new Date().toISOString(),
    };
    writeFileAtomic(f, yaml.dump(next, { lineWidth: 200, noRefs: true }));
}

/**
 * 列房间（**递归**扫 `room.yaml`；坏房间跳过 —— 一个坏目录不该打不开整张列表）。
 *
 * 为什么递归：自 ##166 §28.7 G 起 room id = **taskUri**（`projects/4/tasks/377`）——
 * 目录是**嵌套**的（`rooms/projects/4/tasks/377/room.yaml`），只扫一层会把它们全漏掉
 * （症状：CLI `room list` / UI 左栏只看得见旧的扁平 id 房间）。
 * 判据是「目录里有 `room.yaml`」而不是"目录深度"—— 扁平老房间（`rooms/t377-demo`）照样命中。
 */
export function listRooms(): Room[] {
    const root = roomsRoot();
    if (!existsSync(root)) return [];
    const out: Room[] = [];
    const walk = (dir: string, rel: string): void => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
            if (!ent.isDirectory()) continue;
            const childRel = rel ? `${rel}/${ent.name}` : ent.name;
            const childAbs = join(dir, ent.name);
            if (existsSync(join(childAbs, "room.yaml"))) {
                const r = readRoom(childRel);
                if (r) out.push(r);
                continue; // 一个 room 目录下不会再嵌一个 room
            }
            walk(childAbs, childRel);
        }
    };
    walk(root, "");
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface EnsureRoomInput {
    title?: string;
    members?: RoomMember[];
    /** channel 表（缺省 = 恒有的那条 `default`；本切片没有调用方会传别的） */
    channels?: RoomChannel[];
    /** 缺省接受者（宿主定案后 = 主人格，见 `room-service.ensureRoomForTask`） */
    focus?: string | null;
}

/**
 * 取房间；没有就建一份（成员表由调用方给）。
 *
 * ⚠️ 自 ##166 §28.7 G 起 **room id = taskUri**，且**每个任务对话页恒是一个 room**
 * （成员表至少含主人格）—— 所以正常路径都走 `room-service.ensureRoomForTask`，
 * 本函数只负责"落盘那份"（不读 task、不猜成员）。
 */
export function ensureRoom(id: string, input: EnsureRoomInput = {}): Room {
    const existing = readRoom(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const room: Room = {
        id,
        ...(input.title ? { title: input.title } : {}),
        focus: input.focus ?? null,
        members: input.members ?? [],
        channels: input.channels ?? defaultChannels(),
        lastSeen: {},
        created: now,
        updated: now,
    };
    writeRoom(room);
    return room;
}

/** 移出成员（人/agent 一视同仁；主人格不允许移出 —— 它就是宿主本身） */
export function removeMember(id: string, memberId: string): Room {
    const room = ensureRoom(id);
    const members = room.members.filter((m) => m.id !== memberId || m.main);
    const next: Room = { ...room, members, focus: room.focus === memberId ? null : room.focus };
    writeRoom(next);
    return next;
}

export { isValidRoomId };

/** 加/改成员（按 id 去重；同名冲突不处理 —— 名字只是寻址便利，id 才是键） */
export function upsertMember(id: string, member: RoomMember): Room {
    const room = ensureRoom(id);
    const members = room.members.some((m) => m.id === member.id)
        ? room.members.map((m) => (m.id === member.id ? member : m))
        : [...room.members, member];
    const focus = room.focus && members.some((m) => m.id === room.focus) ? room.focus : (room.focus ?? null);
    const next: Room = { ...room, members, focus };
    writeRoom(next);
    return next;
}

/** 改当前接受者（`null` = 清空；§28.5 B 推论 4：谁都能设，投递只由 to/focus 决定） */
export function setFocus(id: string, focus: string | null): Room {
    const room = ensureRoom(id);
    const next: Room = { ...room, focus };
    writeRoom(next);
    return next;
}

/**
 * **水位前移**（##166 §44.6 四.1）：投递**成功**后调用 —— 把「该成员已看到 <eventId>」写进 room.yaml。
 *
 * 为什么用一条**按房间的 promise 链**串起来：同一条 say 投给 N 个成员时 N 个 `deliverOne` 并发跑，
 * 各自"读 room.yaml → 改自己那一格 → 写回" ⇒ 后写的会把先写的整份覆盖掉（丢水位 = 下次重复注入）。
 * 链按 roomId 分（不同房间不互相阻塞）；写失败不回滚投递（水位是优化，丢一次最坏是多注入一轮）。
 *
 * ⚠️ 返回的 promise **永不 reject**（owner review P1）：`deliverOne` 里 `await` 它的下一行是
 * `input.done(ev)` —— 一旦这里 reject 冒泡，`done` 不执行 ⇒ `post` 的 serverStream 永远等
 * （`for (let finished = 0; finished < tasks.length;)` 靠 `completed` 计数收敛）⇒ **整条投递流挂死**，
 * 不是"晚一点"。水位丢了最坏只是下次多注入一轮别人已说过的话，**绝不能把写盘失败传染给投递**。
 */
const seenChains = new Map<string, Promise<void>>();
export function advanceLastSeen(roomId: string, updates: Record<string, string>): Promise<void> {
    const run = async (): Promise<void> => {
        const room = readRoom(roomId);
        if (!room) return;
        writeRoom({ ...room, lastSeen: { ...room.lastSeen, ...updates } });
    };
    const chain = (seenChains.get(roomId) ?? Promise.resolve()).then(run, run);
    // 链尾存的与返回的**是同一个**（已消化失败）—— 否则下一次 `then(run, run)` 会拿到会 reject 的链，
    // 失败就顺着链一直传下去。
    const safe = chain.catch(() => undefined);
    seenChains.set(roomId, safe);
    return safe;
}

export function roomDeliveriesPath(id: string): string {
    return join(roomDir(id), "deliveries.jsonl");
}

/**
 * 追加一条投递状态（append-only）。
 *
 * 为什么单开一个文件而不是改写 events.jsonl：**事件本体一次写定、永不改**（审计要的是"当时说了什么"），
 * 投递状态是**后到的、会变的**（排队中 → 投递中 → 已投递）。两者生命周期不同，混一个文件就得改写历史。
 */
export function appendDelivery(roomId: string, rec: DeliveryState & { eventId: string }): void {
    mkdirSync(roomDir(roomId), { recursive: true });
    appendFileSync(roomDeliveriesPath(roomId), `${JSON.stringify(rec)}\n`, "utf8");
}

/** 读投递状态：fold 成 `eventId → memberId → 最新状态`（坏行跳过并计数） */
export function readDeliveries(roomId: string): { byEvent: Map<string, Map<string, DeliveryState>>; bad: number } {
    const f = roomDeliveriesPath(roomId);
    const byEvent = new Map<string, Map<string, DeliveryState>>();
    if (!existsSync(f)) return { byEvent, bad: 0 };
    let bad = 0;
    for (const line of readFileSync(f, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let raw: unknown;
        try {
            raw = JSON.parse(t);
        } catch {
            bad++;
            continue;
        }
        const parsed = DeliveryStateSchema.safeParse(raw);
        const eventId = (raw as { eventId?: unknown }).eventId;
        if (!parsed.success || typeof eventId !== "string") {
            bad++;
            continue;
        }
        const inner = byEvent.get(eventId) ?? new Map<string, DeliveryState>();
        inner.set(parsed.data.memberId, parsed.data);
        byEvent.set(eventId, inner);
    }
    return { byEvent, bad };
}

/**
 * 读一个房间的**视图** = 成员表 + 事件流（已附上投递状态 + `delivered` 真值）。
 *
 * `delivered` 为什么要在读侧重算：落盘那一刻还没有投递结果（事件先落盘再 yield 的铁律），
 * 盘上那份恒为 false；真值只有把 deliveries fold 上来才知道。
 */
export function readRoomView(
    roomId: string,
    opts: { limit?: number } = {},
): { room: Room | null; events: RoomEvent[]; bad: number } {
    const room = readRoom(roomId);
    const { events, bad } = readEvents(roomId, opts);
    const { byEvent, bad: badD } = readDeliveries(roomId);
    // replyId → 状态：**回复事件**也要能查到"这一轮是谁投的、轮次 id 是什么"（UI 显示轮次用）
    const byReply = new Map<string, DeliveryState>();
    for (const inner of byEvent.values()) {
        for (const d of inner.values()) {
            if (d.replyId) byReply.set(d.replyId, d);
        }
    }
    const folded = events.map((ev) => {
        const inner = byEvent.get(ev.id);
        if ((!inner || inner.size === 0) && ev.kind === "reply") {
            const d = byReply.get(ev.id);
            return d ? { ...ev, deliveries: [d] } : ev;
        }
        if (!inner || inner.size === 0) return ev;
        const deliveries = [...inner.values()];
        return {
            ...ev,
            deliveries,
            delivered: deliveries.some((d) => d.status === "ok"),
        };
    });
    return { room, events: folded, bad: bad + badD };
}

/** 追加一条事件（append-only；**不重写**整份 —— 事件流只增不改） */
export function appendEvent(roomId: string, ev: RoomEvent): void {
    mkdirSync(roomDir(roomId), { recursive: true });
    // channel **落盘**（##166 §28.K 待拍 17）：`?? DEFAULT_CHANNEL_ID` 只是兜底 ——
    // 调用方（room-service）一律显式给值；这里防的是"将来多一个写入口忘了带"静默落个 undefined。
    const rec = { ...ev, channel: ev.channel ?? DEFAULT_CHANNEL_ID };
    appendFileSync(roomEventsPath(roomId), `${JSON.stringify(rec)}\n`, "utf8");
}

/**
 * 读事件流。坏行**跳过并计数**（不静默：坏行数由调用方上报）——
 * 一次半截写入不该让整个房间打不开。
 */
export function readEvents(roomId: string, opts: { limit?: number } = {}): { events: RoomEvent[]; bad: number } {
    const f = roomEventsPath(roomId);
    if (!existsSync(f)) return { events: [], bad: 0 };
    const lines = readFileSync(f, "utf8").split("\n");
    const events: RoomEvent[] = [];
    let bad = 0;
    for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let raw: unknown;
        try {
            raw = JSON.parse(t);
        } catch {
            bad++;
            continue;
        }
        const parsed = RoomEventSchema.safeParse(raw);
        if (!parsed.success) {
            bad++;
            continue;
        }
        events.push(parsed.data);
    }
    if (opts.limit && opts.limit > 0 && events.length > opts.limit) {
        return { events: events.slice(events.length - opts.limit), bad };
    }
    return { events, bad };
}

/**
 * 事件 id：时间戳 + 进程内序号 + 短随机尾。
 *
 * 为什么要有随机尾：序号只在**单个进程**内唯一，而 main 会重启（改码 / 崩溃）——
 * 重启后序号从头开始，同毫秒撞车理论上就可能（实际靠 ts 兜住，但事件 id 是审计键，不值得赌）。
 */
let evSeq = 0;
export function nextEventId(now = Date.now()): string {
    return `e${now}_${++evSeq}_${Math.random().toString(36).slice(2, 6)}`;
}
