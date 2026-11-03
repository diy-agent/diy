// src/shared/context/log-schema.ts
// 🎯 落盘日志的 **zod 定义 + 读侧校验**（纯模块，禁止 import node:*）
//
// ── 用户 2026-10-06 定的两条原则 ──
//  ①「初版紧凑，扩展松散」：**初版**必须写清哪些字段是**必需**的（我们因此有一个起点，
//     而不是把所有事物都看成可有可无的）；**扩展**字段无法预先枚举 → 一律容忍（不拒收）。
//  ②「校验失败 = **异常数据**」：不当成"缺了就缺了吧"糊过去。比如一条消息缺 `role` ——
//     `role` 是**无法宽松处理**的字段（不知道该把它算成谁说的话），只能整条判为异常，
//     不计入统计 / 不参与重建，并出声。
//
// ── 为什么读侧才校验（写侧不校验）──
// 写是我们自己代码的产物（类型系统已经保证），逐行 safeParse 是热路径上的纯浪费；
// 读侧面对的是**别人/历史版本写下的字节**（旧格式、被手工改过、半行），才是真需要把门的地方。

import { z } from "zod";

/**
 * llm.jsonl 的一行 = 一条原生 ModelMessage + 我们的索引位。
 *
 * 必需（初版契约，三条）：
 *   · `role`    —— 无法宽松处理：缺了不知道这条是谁说的（用户明确点名）
 *   · `content` —— 同上：没有内容的消息没有意义
 *   · `turn`    —— 索引的立身之本；压缩注记的行号区间要靠它反查轮次
 * 扩展（松散，不拒收）：
 *   · `step`    —— 开场 user 块本就没有（见 local-blocks：其 parent 就是 turn）
 *   · `origin`  —— 只有 tool-result 有
 *   · 任何未知字段 —— 将来加字段时**旧读者不许报错**
 */
export const LlmLogLineSchema = z.looseObject({
    role: z.enum(["user", "assistant", "tool"]).describe("消息角色（无法宽松处理：缺了不知是谁说的）"),
    content: z.union([z.string(), z.array(z.unknown())]).describe("原生 content（字符串或 part 数组）"),
    turn: z.string().describe("所属轮 id（索引的立身之本）"),
    step: z.string().optional().describe("所属步 id（开场 user 与插话没有）"),
    origin: z.enum(["tool", "interrupted", "empty"]).optional().describe("tool-result 的输出来源自证位"),
});

export type LlmLogLine = z.infer<typeof LlmLogLineSchema>;

/** 一条被判为异常的行：**行号 + 原因**（行号是修复的唯一线索，必须给） */
export interface LogAnomaly {
    /** 1-based；与注记里的 `range` 同一口径 */
    line: number;
    reason: string;
    /** 原文截断（排障用；不整行回显，日志可能极大） */
    excerpt: string;
}

export interface LogReadResult {
    /** 通过校验的行（异常行**不进这里** —— 不计入统计、不参与重建） */
    lines: LlmLogLine[];
    anomalies: LogAnomaly[];
    /** 总行数（含异常与空行），便于调用方对账"少了多少" */
    total: number;
}

/**
 * 读 llm.jsonl 文本 → 合法行 + 异常清单。
 * 宽松之处（有意）：空行跳过、**未知字段保留**（looseObject）、坏 JSON 只记异常不抛。
 */
export function readLlmLog(text: string): LogReadResult {
    const lines: LlmLogLine[] = [];
    const anomalies: LogAnomaly[] = [];
    let total = 0;
    const raw = text.split("\n");
    for (let i = 0; i < raw.length; i++) {
        const s = raw[i]!.trim();
        if (!s) continue;
        total++;
        let parsed: unknown;
        try {
            parsed = JSON.parse(s);
        } catch {
            anomalies.push({ line: i + 1, reason: "JSON 解析失败（半行/被截断）", excerpt: s.slice(0, 80) });
            continue;
        }
        const r = LlmLogLineSchema.safeParse(parsed);
        if (r.success) lines.push(r.data);
        else
            anomalies.push({
                line: i + 1,
                reason: r.error.issues.map((x) => `${x.path.join(".") || "(根)"}: ${x.message}`).join("；"),
                excerpt: s.slice(0, 80),
            });
    }
    return { lines, anomalies, total };
}

/**
 * 异常清单 → 一句话（给 console.warn / UI 提示用）。
 * 最多列 3 条：排障要看的是"典型长什么样"，不是把日志刷屏。
 */
export function describeAnomalies(as: readonly LogAnomaly[]): string {
    if (as.length === 0) return "";
    const head = as.slice(0, 3).map((a) => `第 ${a.line} 行（${a.reason}）`).join("；");
    return as.length > 3 ? `${head}；等共 ${as.length} 条` : head;
}
