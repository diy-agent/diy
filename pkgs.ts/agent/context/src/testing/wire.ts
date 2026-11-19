// testing/wire.ts —— **wire 级**不变量（所有宿主共用；`./testing` 导出）。
//
// 为什么要它（用户 2026-11-05 / 2026-11-19）：
//   过去上下文测试都是「函数级」：`stepDeltaOf` / `segmentSystemSnapshotOf` 各自绿，
//   但真正发出去的 system 每轮重建一次，缓存照样全失效 —— 因为**没有一条测试看实际字节**。
//   这里把判据固定在「两次请求的原始 system + messages」上，宿主只提供捕获，不提供拼装。
//
// 用法（宿主测试里）：
//   const prev = { system: reqs[0].system, messages: reqs[0].messages };
//   const next = { system: reqs[1].system, messages: reqs[1].messages };
//   assertWireContinuity(prev, next, { maxAdded: 1 });

import { canonical, sha256Hex } from '../hash.js';

/** 一次请求的原始形态（system 是 `streamText({ system })` 的那串字节；messages 是原始数组） */
export interface WireStep {
    readonly system: string;
    readonly messages: readonly unknown[];
}

export function systemHash(step: WireStep): string {
    return sha256Hex(step.system);
}

export function messageHash(message: unknown): string {
    return sha256Hex(canonical(message));
}

/**
 * 段内连续性：system 逐字不变；上一步的 messages 必须是这一步的**前缀**；
 * 新增消息不超过 `maxAdded`（无工具时默认 1；多步工具循环按需放宽）。
 *
 * 失败直接抛（宿主用 `expect(() => ...).not.toThrow()` 或直接调）。
 */
export function assertWireContinuity(prev: WireStep, next: WireStep, opts: { maxAdded?: number } = {}): void {
    if (prev.system !== next.system) {
        throw new Error(
            'system 在段内变了（前缀缓存会整段失效）——\n' +
                `prev sha=${systemHash(prev)} → next sha=${systemHash(next)}`,
        );
    }
    if (next.messages.length < prev.messages.length) {
        throw new Error(`messages 变短了：${prev.messages.length} → ${next.messages.length}（历史被重写）`);
    }
    for (let index = 0; index < prev.messages.length; index++) {
        if (messageHash(prev.messages[index]) !== messageHash(next.messages[index])) {
            throw new Error(
                `第 ${index + 1} 条历史消息变了（只允许在尾部追加）——\n` +
                    `prev=${messageHash(prev.messages[index]).slice(0, 12)} next=${messageHash(next.messages[index]).slice(0, 12)}`,
            );
        }
    }
    const added = next.messages.length - prev.messages.length;
    const max = opts.maxAdded ?? 1;
    if (added > max) {
        throw new Error(`一步追加了 ${added} 条消息（预期 ≤ ${max}）：增量应合成一条 user 信封`);
    }
}

/** system 里不该出现的易变值（出现即缓存必失效；只做提示，规则由调用方决定） */
const VOLATILE_PATTERNS: readonly { name: string; re: RegExp }[] = [
    { name: 'ISO 时间戳', re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ },
    { name: '用量字段', re: /(^|\n)\s*(usage|inputTokens|outputTokens|cacheRead|cacheWrite)\s*:/ },
    { name: '花费字段', re: /(^|\n)\s*cost\s*:/ },
];

/** 返回命中的易变项（空数组 = 看起来稳定）；给测试断言用 */
export function volatileHits(system: string): string[] {
    const hits: string[] = [];
    for (const { name, re } of VOLATILE_PATTERNS) {
        if (re.test(system)) hits.push(name);
    }
    return hits;
}
