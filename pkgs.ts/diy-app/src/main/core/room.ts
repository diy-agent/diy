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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { readTailLines } from "./tail-lines";
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

/**
 * **人成员的阅读游标**前移（##377 第 28 刀）—— 「人已经看到 `<eventId>` 这一条了」。
 *
 * 为什么复用 `lastSeen`（而不是新开一个 `read` 字段）：它记的本来就是「该成员已看到过的
 * 最后一条事件」，对 agent 是投递水位、对人是阅读游标 —— **同一条事实**，两个用途各按自己的
 * 节奏前移（agent 在投递成功后，人在**真看到最新**后）。开第二个字段 = 同一概念两份真源。
 *
 * 三条边界：
 *   · **只认人成员**（`kind === "human"`）：agent 的水位由投递 / 成轮负责，UI 不许替它前移
 *     （前移了 = 下一轮少注入别人的话；那是**静默漏信息**，比多注入坏得多）。
 *   · **没变化不写盘**：UI 每 2.5s 轮询一次，若每次都原子写 room.yaml 就是白烧 IO，
 *     还会让文件 mtime 一直跳（队友的引用稳定器也会白重算）。
 *   · 没有这个房间 / 没有人成员 ⇒ 静默不动（与 `advanceLastSeen` 同一条口径：游标是优化，
 *     丢一次最坏是多提示一条"未读"，而不是把房间搞坏）。
 *
 * 事件 id **不做存在性校验**：游标是流内位置，读侧 `unreadSince` 找不到就按"从头看"处理
 * （校验要读整条事件流，为一个位置水位付这份 IO 不值）。
 */
export async function markRead(roomId: string, eventId?: string): Promise<boolean> {
    const room = readRoom(roomId);
    if (!room) return Promise.resolve(false);
    const humans = room.members.filter((m) => m.kind === "human").map((m) => m.id);
    if (humans.length === 0) return Promise.resolve(false);
    let target = eventId;
    if (!target) {
        // 只要最后一条 ⇒ 倒读 1 行（别为取一个 id 把整条事件流读一遍，##427）
        const { events } = await readEvents(roomId, { limit: 1 });
        target = events[events.length - 1]?.id;
    }
    if (!target) return Promise.resolve(false);
    if (humans.every((id) => room.lastSeen[id] === target)) return Promise.resolve(false);
    const updates: Record<string, string> = {};
    for (const id of humans) updates[id] = target;
    await advanceLastSeen(roomId, updates);
    // `advanceLastSeen` **永不 reject**（它把写盘失败吞掉了，见那条注释）⇒ 想知道"真前移了没"，
    // 只能回读一次盘上那格。不这么做，写失败也会报 `advanced: true` —— 又是「报成功没验证」。
    const after = readRoom(roomId);
    return !!after && humans.every((id) => after.lastSeen[id] === target);
}

export function roomDeliveriesPath(id: string): string {
    return join(roomDir(id), "deliveries.jsonl");
}

/**
 * 追加一条投递状态（append-only）。
 *
 * 为什么单开一个文件而不是改写 events.jsonl：**事件本体一次写定、永不改**（审计要的是"当时说了什么"），
 * 投递状态是**后到的、会变的**（排队中 → 投递中 → 已投递）。两者生命周期不同，混一个文件就得改写历史。
 *
 * **异步**（`rule.tool.async-io`）：主进程是单线程事件循环，`appendFileSync` 会把渲染 / RPC /
 * 流式输出一起按停（##427）。
 */
export async function appendDelivery(roomId: string, rec: DeliveryState & { eventId: string }): Promise<void> {
    await mkdir(roomDir(roomId), { recursive: true });
    await appendFile(roomDeliveriesPath(roomId), `${JSON.stringify(rec)}\n`, "utf8");
}

/**
 * 读盘计数（测试 / 验证用，生产无副作用）：
 *   · `eventsFiles` / `deliveriesFiles` —— 真读了几次盘（证「同一 roomId 在一次刷新窗口里只读一次」）
 *   · `eventsTailBytes` —— 事件流倒读时**实际读了多少字节**（证「limit 真的没读全文」）
 */
const readStats = { eventsFiles: 0, deliveriesFiles: 0, eventsTailBytes: 0 };
export function roomReadStats(): { eventsFiles: number; deliveriesFiles: number; eventsTailBytes: number } {
    return { ...readStats };
}
export function resetRoomReadStats(): void {
    readStats.eventsFiles = 0;
    readStats.deliveriesFiles = 0;
    readStats.eventsTailBytes = 0;
}

/** 从一行 jsonl 里**不解析**地抠出 `eventId`（预筛用：不属于返回窗口的行不进 `JSON.parse`） */
function eventIdOfLine(line: string): string | null {
    const key = '"eventId":"';
    const at = line.indexOf(key);
    if (at < 0) return null;
    const from = at + key.length;
    const end = line.indexOf('"', from);
    return end < 0 ? null : line.slice(from, end);
}

/**
 * 读投递状态：fold 成 `eventId → memberId → 最新状态`（坏行跳过并计数）。
 *
 * `eventIds` = **只要这些事件的投递状态**（`readRoomView` 的返回窗口）：给了它就先用
 * `eventIdOfLine` 做字符串预筛，窗口外的行**不解析**（成本从「整份解析」降到「整份扫行」，##427）。
 * 完整 fold 仍需要整份扫（同一 (eventId, memberId) 可能有多次状态变更，最新的一份才算数），
 * 这里只省解析、不省正确性。
 *
 * 坏行计数口径：给了 `eventIds` 时无法判定归属的坏行（连 `eventId` 都抠不出来的）
 * **不计入** `bad` —— 它们既可能属于窗口内也可能属于窗口外，报哪个都是猜。
 */
export async function readDeliveries(
    roomId: string,
    opts: { eventIds?: ReadonlySet<string> } = {},
): Promise<{ byEvent: Map<string, Map<string, DeliveryState>>; bad: number }> {
    const f = roomDeliveriesPath(roomId);
    const byEvent = new Map<string, Map<string, DeliveryState>>();
    let text: string;
    try {
        text = await readFile(f, "utf8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { byEvent, bad: 0 };
        throw e;
    }
    readStats.deliveriesFiles++;
    let bad = 0;
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const want = opts.eventIds;
        if (want) {
            const eid = eventIdOfLine(t);
            if (!eid || !want.has(eid)) continue;
        }
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

/** 房间视图（`readRoomView` 的返回值；也是 `readRoomViewCached` 的缓存单元） */
export interface RoomView {
    room: Room | null;
    events: RoomEvent[];
    bad: number;
}

/**
 * 读一个房间的**视图** = 成员表 + 事件流（已附上投递状态 + `delivered` 真值）。
 *
 * `delivered` 为什么要在读侧重算：落盘那一刻还没有投递结果（事件先落盘再 yield 的铁律），
 * 盘上那份恒为 false；真值只有把 deliveries fold 上来才知道。
 *
 * `opts.limit`（> 0）= **只要最后 N 条** —— 事件流用倒读（`readEvents`），投递状态用
 * `eventIds` 预筛（`readDeliveries`），两条路径都不再读全文（##427）。
 */
export async function readRoomView(roomId: string, opts: { limit?: number } = {}): Promise<RoomView> {
    const room = readRoom(roomId);
    const { events, bad } = await readEvents(roomId, opts);
    const { byEvent, bad: badD } = await readDeliveries(
        roomId,
        events.length > 0 ? { eventIds: new Set(events.map((e) => e.id)) } : {},
    );
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

/** 追加一条事件（append-only；**不重写**整份 —— 事件流只增不改）。异步 IO，理由同 `appendDelivery` */
export async function appendEvent(roomId: string, ev: RoomEvent): Promise<void> {
    await mkdir(roomDir(roomId), { recursive: true });
    // channel **落盘**（##166 §28.K 待拍 17）：`?? DEFAULT_CHANNEL_ID` 只是兜底 ——
    // 调用方（room-service）一律显式给值；这里防的是"将来多一个写入口忘了带"静默落个 undefined。
    const rec = { ...ev, channel: ev.channel ?? DEFAULT_CHANNEL_ID };
    await appendFile(roomEventsPath(roomId), `${JSON.stringify(rec)}\n`, "utf8");
}

/** 逐行解析成事件（坏行**跳过并计数** —— 不静默、也不让一行坏数据炸掉整条流） */
function parseEventLines(lines: readonly string[]): { events: RoomEvent[]; bad: number } {
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
    return { events, bad };
}

/**
 * 读事件流。`limit > 0` = **只读最后 N 行**（从文件尾倒读，`tail-lines.readTailLines`）——
 * 这是本文件的核心成本（##427）：append-only 流只会越来越长，而轮询要的永远是尾巴。
 *
 * 两条口径：
 *   · 坏行**跳过并计数**（不静默：坏行数由调用方上报）；一次半截写入不该让整个房间打不开。
 *   · **`limit` 模式下 `bad` 只数读到的这个窗口**（窗口外的坏行压根没进内存）—— 要全量计数
 *     就不传 `limit`。
 */
export async function readEvents(roomId: string, opts: { limit?: number } = {}): Promise<{ events: RoomEvent[]; bad: number }> {
    const f = roomEventsPath(roomId);
    const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 0;
    if (limit > 0) {
        // 窗口按**行**倒读；窗口里混了坏行 ⇒ 名额被挤掉，向尾部再宽一档重读（至多 2 次翻倍）。
        // 判据（任务 body）：「坏行只影响自身，其余 N-1 条正常返回」—— 所以不能因为夹了一条坏行
        // 就只给 N-2 条。重读只在真有坏行时发生（正常房间零额外成本）。
        let window = limit;
        for (let attempt = 0; ; attempt++) {
            const { lines, bytesRead, atStart } = await readTailLines(f, window);
            if (lines.length === 0) return { events: [], bad: 0 };
            readStats.eventsFiles++;
            readStats.eventsTailBytes += bytesRead;
            const parsed = parseEventLines(lines);
            const tail = parsed.events.length > limit ? { events: parsed.events.slice(parsed.events.length - limit), bad: parsed.bad } : parsed;
            const enough = tail.events.length >= limit || atStart || attempt >= 2;
            if (parsed.bad === 0 || enough) return tail;
            window *= 2;
        }
    }
    let text: string;
    try {
        text = await readFile(f, "utf8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { events: [], bad: 0 };
        throw e;
    }
    readStats.eventsFiles++;
    return parseEventLines(text.split("\n"));
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
