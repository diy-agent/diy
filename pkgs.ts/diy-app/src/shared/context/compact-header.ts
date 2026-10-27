// src/shared/context/compact-header.ts
// 🎯 压缩后**顶替被压段的那条消息**（##442 刀 2）：只在压缩事件后出现，位置 = system 之后第一条。
//
// ── 结构只有一份（用户 2026-10-27 定）──
// 两种摘要来源**不是两种结构**，同一条消息里字段完全一样，只是 `summary` 的来源不同：
//
//   compact:
//     at / droppedMessages / lines{from,to} / maxLineBytes / source / index / turns   ← 压缩那一刻的事实
//     summary: |-     ← 现成结论；**空串 = 没有现成的，需要你自己查出来再写**（self）
//     task:    |-     ← 下一步任务指导（两种模式都有；self 多一段"怎么查"）
//
// 所以：`summary` 恒在（可能为空）、`task` 恒在、其余事实恒在。
// 判断"要不要自己查"只看 `summary` 是否为空 —— 不需要一个 `mode` 字段出现在消息里。
//
// ── 为什么在头部（用户拍板）──
// 语义正确：它替代的就是那段历史，模型按时间顺序读天然接得上。
// 代价：每次压缩把「compact 之后的前缀缓存」破一次 —— 摊销到两次压缩之间的几十上百步约
// $0.0001/步（可忽略）；而**每轮**都破一次（曾经的 `history:` 注记）才是灾难。
//
// ── 头部不变量（务必守住）──
// 这条消息在两次压缩之间必须**逐字节不变**：只放"压缩那一刻定下的事实"（时间 / 丢了多少 / 行号区间 /
// 文件路径），**不放**每轮都会变的量（窗口占用、上一步花费、当前时间……）—— 那些去尾部
// `runtime:` / `runtimeDiff:`。反例见 ##266：`history:` 注记的 `kept` 右端点每轮 +N，
// 导致每轮首步只有 8k token 命中、其余 120k 全价。
//
// 纯函数：禁止 import node:*（真发 / 预览 / 单测共用同一份）。

import { toYaml } from "./render";

/** 压缩那一刻定下、之后不再变的一组事实 */
export interface CompactFacts {
    /** 压缩时刻（ISO） */
    at: string;
    /** 丢掉的**消息条数**（= llm.jsonl 行数；名字带单位，别叫 `dropped`） */
    droppedMessages: number;
    /** 被丢掉的**行号区间**（1-based，含两端；行号 == 消息序号） */
    lines: { from: number; to: number };
    /** llm.jsonl 绝对路径（每行一条消息） */
    source: string;
    /** 行号 → 字节偏移的索引（`tail -c +off <source>` = O(1) 取行；##442） */
    index?: string;
    /** turns.jsonl 绝对路径（每行一轮：turnId / 时间 / 用户那句话 / 我这一轮说了什么） */
    turns?: string;
    /**
     * 文件里**最长的一行**多少字节（266 实测 9.98 MB）。
     * 为什么必须给：单行整段取出来会直接撑爆上下文 ⇒ 模型据此决定"先 `head -c` 截断"。
     */
    maxLineBytes?: number;
}

export interface CompactHeaderInput extends CompactFacts {
    /** 现成结论（`model` 模式由压缩时那次模型调用产出）；**空串 = 没有，需要自己查**（`self`） */
    summary?: string;
    /** 这份结论是**上一次压缩继承来的**（本次没生成新摘要）⇒ 提示"可能过时" */
    summaryCarried?: boolean;
    /**
     * 下一步任务指导（两种模式都有）。
     * 传 `undefined` 用缺省文案；`summary` 为空时缺省文案会自动带上"怎么查"那一段。
     */
    task?: string;
}

/** 给人读的千分位（**只用于叙述文字**；命令行参数一律用原数 —— 逗号进 shell 会变成"多列地址"） */
const fmt = (n: number): string => n.toLocaleString("en-US");

/** 检索指令（`summary` 为空时必带；有结论时也给 —— 深挖原文仍然要用） */
function searchGuide(i: CompactFacts): string[] {
    const { from, to } = i.lines;
    const seek = i.index
        ? `tail -c +$(( $(sed -n "\${N}p" ${i.index}) + 1 )) ${i.source} | head -c 4000   # N = 行号，O(1)`
        : `sed -n '<N>p' ${i.source} | head -c 4000`;
    return [
        "怎么查原文：",
        "① 按轮找线索（比按行扫便宜；每行一轮：turnId / 时间 / 用户那句话 / 我这一轮说了什么）",
        i.turns ? `   grep -n -m 5 '<关键词>' ${i.turns}` : "   （turns.jsonl 路径见上，按关键词 grep）",
        "② 取某一条消息 —— **必须先截断**（单行可能几 MB，整段取会撑爆上下文）",
        `   ${seek}`,
        `   sed -n '${from},${to}p' ${i.source} | head -c 8000   # 按区间扫（慢，但认得全文）`,
        i.maxLineBytes
            ? `   ⚠️ 这个文件里最长的一行有 ${fmt(i.maxLineBytes)} 字节 —— 直接 sed 不截断会一次灌满窗口。`
            : "   ⚠️ 单行可能很长：直接 sed 不截断会一次灌满窗口。",
    ];
}

/** 缺省的下一步指导：`summary` 空 ⇒ 先自查自写；非空 ⇒ 照着未完成项接着干 */
function defaultTask(i: CompactHeaderInput): string {
    const head = `上面的对话被压缩掉了（第 ${fmt(i.lines.from)}–${fmt(i.lines.to)} 行，共 ${fmt(i.droppedMessages)} 条消息）。`;
    const hasSummary = (i.summary ?? "").trim().length > 0;
    const stale = i.summaryCarried
        ? "（注意：这份结论是**上一次压缩**留下的，本次没有重新生成 —— 可能已经过时，动手前先核一遍。）"
        : "";
    const body = hasSummary
        ? [
              "`summary` 是那段对话的结论。" + stale + "按它的「未完成 / 下一步」继续干活；结论不够时再按下面的办法查原文。",
              "",
              ...searchGuide(i),
          ]
        : [
              "**`summary` 是空的** —— 没有现成结论，你需要自己查出来，再继续干活。",
              "",
              ...searchGuide(i),
              "",
              "查完先写一份**当前状况**，四类内容：",
              "  - 结论：已经确定的事实（谁 / 什么 / 为什么）",
              "  - 决策：定了什么、为什么这么定",
              "  - 未完成：下一步该做什么",
              "  - 踩坑：试过但不对的路，别重走",
              "一行一句，不许抄原文段落；不知道就写不知道，不要编。",
          ];
    return [head, "", ...body].join("\n");
}

/**
 * 渲染压缩头部消息（**唯一结构**）：`compact:` 顶层键一段，里面事实 + `summary` + `task`。
 */
export function renderCompactHeader(i: CompactHeaderInput): string {
    const summary = (i.summary ?? "").trim();
    return toYaml({
        compact: {
            at: i.at,
            droppedMessages: i.droppedMessages,
            lines: { from: i.lines.from, to: i.lines.to },
            ...(i.maxLineBytes ? { maxLineBytes: i.maxLineBytes } : {}),
            source: i.source,
            ...(i.index ? { index: i.index } : {}),
            ...(i.turns ? { turns: i.turns } : {}),
            // 恒在：空串 = 没有现成结论（读的人据此决定"自己查"），不是"字段缺失"
            summary,
            task: i.task ?? defaultTask(i),
        },
    });
}
