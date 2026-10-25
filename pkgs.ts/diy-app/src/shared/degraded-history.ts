// src/shared/degraded-history.ts
// 🎯 降级历史（##424 刀 2）的**跨层契约**：main 产出的标记 + 渲染端要显示的文案。
//
// 为什么要一个共享文件：这个标记同时出现在
//   · main（`local-agent.ts::degradedHistory` 产出、`historyWindow` 回包）与
//   · renderer（会话页顶部横幅 + 轮内行内标注）
// 两侧**必须同一句话、同一组值域** —— 文案散在两侧必分叉（rule 5：文案归出口，不归渲染层）。

/** 降级原因：ops 缺失 / 为空 / 格式断代 / 被截断（后两者来自 `resolveOpsReplay`） */
export type DegradedCause = "missing" | "empty" | "schema-break" | "truncated";

/**
 * 降级重建的可见标记。**有它就意味着「这份历史不是 ops 原文」** ——
 * 此时回包的 ops 是 `turns.jsonl` 折成的只读文本历史（user + assistant 正文）。
 */
export interface DegradedHistory {
    cause: DegradedCause;
    /** 人话原因（横幅里「历史明细不可用（<note>）」那半句） */
    note: string;
    /** 重建出来的轮数 */
    turns: number;
    /** 其中锚点已悬空的轮数（文件缺失 / 越界 / 行号不符）—— 行内写「原始记录已清理」 */
    dangling: number;
}

/** 每种原因的一句话（横幅主语；**判据归 main、文案归这里**，渲染层只拼不造句子） */
export const DEGRADED_CAUSE_TEXT: Record<DegradedCause, string> = {
    missing: "会话明细日志不存在（被清理或换过数据根）",
    empty: "会话明细日志为空",
    "schema-break": "会话明细格式已断代（旧版本日志不再解析）",
    truncated: "会话明细被截断或替换",
};

/** 会话页顶部横幅的全句（body 刀 2 §2 定死的口径） */
export function degradedBannerText(d: DegradedHistory): string {
    return `历史明细不可用（${d.note || DEGRADED_CAUSE_TEXT[d.cause] || d.cause}），以下为结论文本记录（${d.turns} 轮）`;
}

/** 轮内行内标注（锚点已悬空时）：如实说「原始记录已清理」，不静默空白 */
export const DEGRADED_DANGLING_TEXT = "原始记录已清理";
