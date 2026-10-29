// types.ts — @diy/room 的公开契约（纯类型）
//
// 边界（##456「关键设计决策 ②／③」）：
//   属于 Room：成员表 / 收件人解析（`@X` / focus / `@all`）/ 投递 / 忙闲 / 事件流聚合
//   不属于 Room：单个会话怎么跑（@diy/agent-session）/ 任务状态（task 依赖 room，反向不行）/
//                文件系统（RoomStore 适配器）
//
// ⚠️ 本包里**不认识任务**：没有任务 URI、没有任务标识，也没有「room id 就是任务 URI」这类假设。
// 现有数据恰好 id == 任务 URI 只说明可以原样沿用，不代表房间知道任务存在（意图测试 R7 静态扫）。

import type { Clock, SessionDelta, SessionPeer } from '@diy/agent-session';

export type { Clock, SessionDelta, SessionPeer };

/** 成员类型：人也是一等参与者（人没有 session） */
export type MemberKind = 'human' | 'agent';

/** addMember 的入参 */
export interface RoomMemberInit {
    /** 成员 id（房间内唯一） */
    id: string;
    /** 显示名（`@name` 按它寻址；重名时按 id 寻址） */
    name: string;
    kind: MemberKind;
    /** agent 成员的会话（人没有；缺省 = 给它送不了话，投递记 `skipped`） */
    session?: SessionPeer;
}

/** 成员活视图 */
export interface RoomMember {
    readonly id: string;
    readonly name: string;
    readonly kind: MemberKind;
    readonly session?: SessionPeer;
}

/** 事件类型：发言 / 某个 agent 的回复 */
export type RoomEventKind = 'message' | 'response';

/** 房间里的一条事件（append-only；id 房间内唯一） */
export interface RoomEvent {
    readonly id: string;
    readonly roomId: string;
    readonly kind: RoomEventKind;
    /** 发言人（成员 id） */
    readonly author: string;
    readonly content: string;
    /** ISO-8601，由 Clock 决定 */
    readonly at: string;
    /** response 指向它回应的那条 message */
    readonly replyTo?: string;
    /** 本条被投给了谁（成员 id；空数组 = 只落记录，没投递） */
    readonly recipients: readonly string[];
}

/**
 * 一次投递的状态机：queued → delivering → delivered | failed；不可投递（人 / 无 session）直接 skipped。
 * 与事件本体分开：事件**只增不改**，投递状态是副作用记录。
 */
export type DeliveryState = 'queued' | 'delivering' | 'delivered' | 'skipped' | 'failed';

/** 某个事件对某个成员的投递状态 */
export interface Delivery {
    readonly eventId: string;
    readonly memberId: string;
    readonly state: DeliveryState;
    /** 补充说明（为什么 skipped / failed） */
    readonly note?: string;
}

/** 成员表快照（不含活对象：store 适配器看到的是纯数据） */
export interface RoomMemberSnapshot {
    readonly id: string;
    readonly name: string;
    readonly kind: MemberKind;
    readonly hasSession: boolean;
}

/** 房间快照（成员表 + focus；事件走 appendEvent 单独追加） */
export interface RoomSnapshot {
    readonly id: string;
    readonly members: readonly RoomMemberSnapshot[];
    readonly focus: string | null;
    readonly updatedAt: string;
}

/**
 * Room 主线的消息分类（##456「数据分层修订」）：**只有**人说的话和 agent 的结论进主线。
 * 过程（agent-trace / tool-call / tool-result）永远只在二级会话日志里。
 */
export type PublicLogKind = 'human' | 'agent-conclusion';

/**
 * Room 主线的一条（一级数据：长期保留、可同步/查询）。
 *
 * **`text` 是正文副本，不是引用**：二级会话日志会被压缩 / 裁剪 / 丢弃，
 * 主线要在这之后还读得到原话。`sessionId` / `messageId` 只是溯源线索，不能作为唯一存储。
 */
export interface PublicLogEntry {
    /** ISO-8601，由 Clock 决定 */
    readonly at: string;
    /** 谁说的（成员 id） */
    readonly from: string;
    readonly kind: PublicLogKind;
    /** 正文副本（不是引用） */
    readonly text: string;
    /** 来自哪个会话（agent 的结论才有） */
    readonly sessionId?: string;
    /** 对应哪条房间事件（溯源用；不保证二级日志里还能找到） */
    readonly messageId?: string;
}

/**
 * 存储端口（可选）。缺省 = 纯内存。
 * 三个方法分开是因为三种数据的寿命与写形态不同：
 *   事件流 = 只追加；成员表 = 整表覆盖；主线日志 = 只追加且**长期保留**（不是事件流的缓存）。
 */
export interface RoomStore {
    appendEvent(event: RoomEvent): void | Promise<void>;
    saveMembers(snapshot: RoomSnapshot): void | Promise<void>;
    appendPublicLog(entry: PublicLogEntry): void | Promise<void>;
}

/** post 的入参 */
export interface PostInput {
    /** 发言人（必须是房间成员） */
    from: string;
    text: string;
    /** 显式收件人（成员 id 或 `@all`）；缺省时按正文里的 `@name` 解析，再退到 focus */
    to?: readonly string[];
}

/** 房间活视图 */
export interface Room {
    readonly id: string;
    readonly members: readonly RoomMember[];
    readonly events: readonly RoomEvent[];
    readonly deliveries: readonly Delivery[];
    /** 主线日志：人说的话 + agent 的结论（正文副本，长期保留） */
    readonly publicLog: readonly PublicLogEntry[];
    /** 隐式收件人（没有 `@` 时投给它）；null = 没有 */
    readonly focus: string | null;
    addMember(init: RoomMemberInit): RoomMember;
    removeMember(id: string): void;
    setFocus(id: string | null): void;
    /** 该成员此刻是否有投递在跑（含它自己 session 的忙） */
    busy(memberId: string): boolean;
    /** 某个事件对某个成员的投递状态（没投过 = undefined） */
    deliveryOf(eventId: string, memberId: string): Delivery | undefined;
    /** 发一条发言：先落事件再 yield；返回的流里会陆续出现各 agent 的回复事件 */
    post(input: PostInput): AsyncGenerator<RoomEvent>;
}
