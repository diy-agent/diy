// model.ts —— 类型从 chat-core 来；这里只留 UI 用的常量与再导出（避免两处定义漂移）。

export type { Author, Bot, Delivery, Item, Room } from '@diy-agent/chat-core';
export { botsOf, dirOf, primaryBotOf } from '@diy-agent/chat-core';

export const DIR_SUGGESTIONS = ['~/git/diy/diy', '~/git/diy/diy-research', '~/git/cops', '~/git/sha'];

/** 已知的容器类型只用于图标/文案，未知类型按通用容器显示 */
export function roomTypeLabel(type: string): string {
    if (type === 'project') return '项目';
    if (type === 'task') return '任务';
    return type;
}
