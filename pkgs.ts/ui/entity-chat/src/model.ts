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
 */
export const TASK_STATUSES = [
    { value: 'todo', label: '未开始', dot: 'bg-slate-400', text: 'text-muted-foreground' },
    { value: 'doing', label: '进行中', dot: 'bg-sky-400', text: 'text-sky-400' },
    { value: 'done', label: '已完成', dot: 'bg-emerald-400', text: 'text-emerald-400' },
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number]['value'];

const STATUS_VALUES = new Set<string>(TASK_STATUSES.map((item) => item.value));

/** 容器上的状态；不是合法值（老数据 / 手改错）都当「未开始」 */
export function taskStatusOf(room: Room): TaskStatus {
    const raw = room.data['status'];
    return typeof raw === 'string' && STATUS_VALUES.has(raw) ? (raw as TaskStatus) : 'todo';
}

export function statusMeta(status: TaskStatus): (typeof TASK_STATUSES)[number] {
    return TASK_STATUSES.find((item) => item.value === status) ?? TASK_STATUSES[0];
}

/** 点一下切到下一个状态：未开始 → 进行中 → 已完成 → 未开始 */
export function nextTaskStatus(status: TaskStatus): TaskStatus {
    const index = TASK_STATUSES.findIndex((item) => item.value === status);
    return TASK_STATUSES[(index + 1) % TASK_STATUSES.length]!.value;
}
