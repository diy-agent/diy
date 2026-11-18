// model.ts —— 类型从 chat-core 来；这里只留 UI 用的常量与再导出（避免两处定义漂移）。

import type { Room } from '@diy-agent/chat-core';

export type { Author, Bot, Delivery, Item, Room, TurnEndReason } from '@diy-agent/chat-core';
export { botsOf, dirOf, primaryBotOf } from '@diy-agent/chat-core';

export const DIR_SUGGESTIONS = ['~/git/diy/diy', '~/git/diy/diy-research', '~/git/cops', '~/git/sha'];

/** 已知的容器类型只用于图标/文案，未知类型按通用容器显示 */
export function roomTypeLabel(type: string): string {
    if (type === 'project') return '项目';
    if (type === 'task') return '任务';
    return type;
}

/**
 * 任务状态：落 `room.data.status`，枚举是 UI 的决定（后端只负责存）。
 * 值用英文短词 —— 它是落库字段，不是给人看的（label 才是）。
 *
 * **只有两态**，就是 GitHub issue 的 open / closed（用户：跟 GitHub 一样，closed 的就从项目树藏起来）：
 *   open = 绿圈（还在手上）· closed = 紫勾（收工，进「已关闭」表）。
 * 形状在 `components/RoomName.tsx::STATUS_ICON`（图标唯一实现），这里只给文字色。
 *
 * 原先的三态 todo / doing / done 已废：「进行中」不是状态 —— 真在跑没在跑看的是会话（running），
 * 而这个字段是人手填的结论。老数据不迁移，读的时候归一（`LEGACY_STATUS`），下次写回才变新值。
 *
 * 已没有 `dot`（彩色圆点）字段：状态改成一个**形状**之后，圆点那套颜色就是第二份真相，
 * 留着早晚与图标对不上（这也是先前「同一个状态两处画法不同」的成因）。
 */
export const TASK_STATUSES = [
    { value: 'open', label: 'open', text: 'text-emerald-500' },
    { value: 'closed', label: 'closed', text: 'text-violet-400' },
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number]['value'];

/** 老的三态怎么归一：todo / doing 都是 open，done 是 closed */
const LEGACY_STATUS: Record<string, TaskStatus> = { todo: 'open', doing: 'open', done: 'closed' };

const STATUS_VALUES = new Set<string>(TASK_STATUSES.map((item) => item.value));

/** 容器上的状态；不是合法值（老数据 / 手改错）都当 open */
export function taskStatusOf(room: Room): TaskStatus {
    const raw = room.data['status'];
    if (typeof raw !== 'string') return 'open';
    if (STATUS_VALUES.has(raw)) return raw as TaskStatus;
    return LEGACY_STATUS[raw] ?? 'open';
}

/**
 * 关闭了没有：项目树按它过滤，已关闭表按它收集。
 * 只对 task 成立 —— 别的类型（project / stock…）没有 open/closed 这回事，
 * 哪怕它们的 data 里碰巧有 status 也不该被当成「已关闭」。
 */
export function isClosed(room: Room): boolean {
    return room.type === 'task' && taskStatusOf(room) === 'closed';
}

/**
 * 关闭时刻（毫秒，落 `room.data.closedAt`，关闭时由 `store.setRoomStatus` 顺手盖上）。
 * 三态时代留下的 done 没有这个键 —— 返回 undefined：排序垫底、单元格显示「—」。
 */
export function closedAtOf(room: Room): number | undefined {
    const raw = room.data['closedAt'];
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * 历史行的关闭时间：**相对**说法（「3 小时前」），不是时间戳。
 *
 * 侧栏只有 256px，一行里塞着名字 + 项目 tag，再放 `2026-11-17 06:14` 就把名字挤没了；
 * 而翻历史时关心的是「多久以前」，绝对时刻放 `title`（悬停可见）更合适。
 * 超过一周就给日期 —— 「23 天前」这种说法没人真的在算。
 *
 * `now` 可注入：测试不能依赖真实时钟。
 */
export function formatClosedAgo(closedAt: number | undefined, now: number = Date.now()): string | undefined {
    if (closedAt === undefined) return undefined;
    const diff = now - closedAt;
    // 将来时间（时钟回拨 / 手工改库）：别说「-3 分钟前」，退化成「刚刚」
    if (diff < 60_000) return '刚刚';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
    const date = new Date(closedAt);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    // 跨年才带年份：同年的历史行写 `11-17` 就够
    return date.getFullYear() === new Date(now).getFullYear()
        ? `${month}-${day}`
        : `${date.getFullYear()}-${month}-${day}`;
}

/** 悬停用的绝对时刻（本地时区，精确到分钟） */
export function formatClosedAtAbsolute(closedAt: number | undefined): string | undefined {
    if (closedAt === undefined) return undefined;
    const date = new Date(closedAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function statusMeta(status: TaskStatus): (typeof TASK_STATUSES)[number] {
    return TASK_STATUSES.find((item) => item.value === status) ?? TASK_STATUSES[0];
}

/** 点一下在 open / closed 之间切（两态，所以是 toggle，不是循环里的下一个） */
export function toggleTaskStatus(status: TaskStatus): TaskStatus {
    return status === 'open' ? 'closed' : 'open';
}

/**
 * 树里该不该出现：已关闭的任务不进项目树（用户：closed 的藏起来）。
 * 非任务（以后别的子类型）一律照旧显示 —— 它们没有 open/closed 这回事。
 */
export function visibleInTree(room: Room): boolean {
    return !isClosed(room);
}

/**
 * 导航底部「历史任务」区的行：所有已关闭的任务，按关闭时刻倒序（最近关的在最上面）。
 * 没有 `closedAt` 的老数据垫底（当 0）—— 不给它们抢最近的位置。
 */
export function closedTasksOf(rooms: Room[]): Room[] {
    return rooms.filter(isClosed).sort((a, b) => (closedAtOf(b) ?? 0) - (closedAtOf(a) ?? 0));
}
