// src/shared/context/select-kept-boundary.ts
// 🎯 「按上限算保留边界」—— **唯一实现点**，范例预览（##423 块 3）与（将来的）真实压缩共用同一套判据。
//
// ── ⚠️⚠️ 临时实现，##432 落地后整文件删除 ──
// 本文件是 ##432（压缩算法简化：一条上限 / 从后往前数 step / 保头 600 硬编码 / 边界一次算）的
// **临时代管实现**：签名与 ##432 约定的一致（`selectKeptBoundary(messages, budgetTokens) → { headEnd, cut }`，
// 同目录、零 IO、可单测），所以 ##432 的正式版落地后，只需把本文件换成
//     export { selectKeptBoundary } from "<##432 的实现>";   // + 类型再导出
// 调用方（`compact-example.ts` / 面板）**一行不用改**。
// 🚫 不许在别处再写一份累加 / 配平逻辑 —— 「示例与真实行为不一致」比没有示例更糟。
//
// 判据（与 ##432 口径一致）：
//   ① 保头：从第一条起装到 ≥ 600 token 为止，第一个 user / 任务目标永不被丢，也不参与上限累加；
//   ② 从最后一条往前累加，累积 ≥ 上限即停（上限 0 = 只留保头）；
//   ③ 切点必须 tool 配对平衡：留了 result 就必须留下它的 call（整组前移）。
//
// 纯函数：禁止 import node:*。

/** 边界计算只需要「多大」与「工具配对」两件事，不绑定具体消息类型 */
export interface BoundaryMessage {
    /** 该条消息的估算 token 数 */
    tokens: number;
    /** `call` / `result` 成对；其余（正文 / user）不用管 */
    kind?: string;
    /** 工具调用与结果共用的 id */
    callId?: string;
}

export interface KeptBoundary {
    /** 保头区最后一条的下标（-1 = 没有保头） */
    headEnd: number;
    /** 尾部保留区的起点下标；`messages.length` = 尾部一条都不取（上限 0 的情形） */
    cut: number;
}

/** 保头（token）—— ##432 定为硬编码 600，不进配置 */
export const HEAD_KEEP_TOKENS = 600;

/**
 * 把切点往前挪到 tool 配对平衡处：留了 result 就必须留它的 call。
 * （挪完之后新切点自身若又是 result ⇒ 循环继续，处理嵌套的前一组）
 */
function balanceCut(messages: readonly BoundaryMessage[], cut: number, headEnd: number): number {
    let c = cut;
    for (let guard = 0; guard < messages.length && c > headEnd; guard++) {
        if (c >= messages.length) return c; // 尾部一条都没取（全在保头里）
        const m = messages[c];
        if (m.kind !== "result" || !m.callId) return c;
        const callIdx = messages.findIndex((x) => x.kind === "call" && x.callId === m.callId);
        if (callIdx < 0 || callIdx >= c) return c;
        c = callIdx;
    }
    return c;
}

/**
 * 按上限算保留边界。
 *
 * @param messages 消息序列（只需 `tokens` 与工具配对字段）
 * @param budgetTokens 上限（token；0 = 清零：只留保头）
 */
export function selectKeptBoundary(
    messages: readonly BoundaryMessage[],
    budgetTokens: number,
): KeptBoundary {
    // ① 保头
    let headEnd = -1;
    let headTokens = 0;
    for (let i = 0; i < messages.length; i++) {
        if (headTokens >= HEAD_KEEP_TOKENS) break;
        headTokens += messages[i].tokens;
        headEnd = i;
    }

    // ② 清零：尾部一条都不取
    if (budgetTokens === 0) return { headEnd, cut: messages.length };

    // ③ 从最后往前累加，累积 ≥ 上限即停
    let acc = 0;
    let cut = messages.length;
    for (let i = messages.length - 1; i > headEnd; i--) {
        if (acc >= budgetTokens) break;
        acc += messages[i].tokens;
        cut = i;
    }
    return { headEnd, cut: balanceCut(messages, cut, headEnd) };
}
