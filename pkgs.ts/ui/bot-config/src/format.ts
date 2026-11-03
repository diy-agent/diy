// format.ts — 页面用的纯格式化函数（**零依赖**：renderer 打包会把这些带进浏览器上下文）。
//
// 为什么不放 actions.ts：那边 import @diy-agent/bot（node:fs）/ @diy-agent/llm-provider，
// renderer 的 esbuild 是 `--platform=browser`，带上它整包就编不过（同 ##467 的经验）。
import type { BotView, ModelOptionView, TestMessageView } from './shared.js';

/** 模型限定名 `providerId/modelId` */
export function modelKeyOf(model: ModelOptionView): string {
    return `${model.providerId}/${model.modelId}`;
}

/** 列表里模型那一列：空 = 跟随缺省 */
export function modelLabel(model: string | null): string {
    return model === null ? '（跟随缺省）' : model;
}

/** bot 的会话数文案（0 也要说人话） */
export function sessionCountLabel(bot: BotView): string {
    return bot.sessionCount === 0 ? '0（还没有会话）' : String(bot.sessionCount);
}

/** 时间戳 → `MM-DD HH:mm`（给列表用；非法值原样返回） */
export function timeLabel(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 测试对话的发言者标签 */
export function roleLabel(role: TestMessageView['role']): string {
    return role === 'user' ? '我' : 'bot';
}

/** 用量一行字（没调用过就说没调用过，不显示 0/0 的假精确） */
export function usageLabel(usage: { inputTokens: number; outputTokens: number; turns: number }): string {
    if (usage.turns === 0) return '还没对话';
    return `${usage.turns} 轮 · 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} tokens`;
}
