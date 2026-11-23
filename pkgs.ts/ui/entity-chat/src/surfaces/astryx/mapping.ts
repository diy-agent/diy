// mapping.ts —— **Astryx 面专属**的映射：工具状态枚举 + 投递状态降级。
//
// 与框架无关的纯映射（工具行 target、parts 分组）已抽到 `../shared`，两面共用；
// 这里只剩绑定了 Astryx 类型的那一层。

import type { ChatMessageStatus } from '@astryxdesign/core';
import type { TimelineEntry } from '@diy-agent/chat-core';

// 原来的位置在这里，现在两面共用一份（见 shared.ts 头注释）
export { runsOf, toolTargetOf, type Run } from '../shared';

/** Astryx 的工具状态枚举叫 `complete`，不是 `ok` —— 这是它与 shadcn 面唯一不能共用的常量 */
export const TOOL_STATUS = { running: 'running', ok: 'complete', error: 'error' } as const;

type Delivery = TimelineEntry['deliveries'][number];

/**
 * 只表达"出问题了"。
 * queued/delivering 是 bot 正在执行，界面上已经有执行中指示器 —— 再标一个
 * "发送中"会让用户以为消息还没出去，和执行中重复。
 */
export function deliveryStatusOf(deliveries: readonly Delivery[]): ChatMessageStatus | undefined {
    return deliveries.some((delivery) => delivery.state === 'failed') ? 'error' : undefined;
}

/** 同理：只在真出问题时才占一行说明是谁失败了 */
export function deliveryFooterOf(deliveries: readonly Delivery[]): string | undefined {
    const failed = deliveries.filter((delivery) => delivery.state === 'failed');
    if (failed.length === 0) return undefined;
    return failed.map((delivery) => `${delivery.name} 未送达`).join('、');
}
