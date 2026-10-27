// src/shared/context/compact-header.ts
// 🎯 压缩后**顶替被压段的那条消息**（##442 刀 2）：只在压缩事件后出现，位置 = system 之后第一条。
//
// ── 为什么在头部（用户 2026-10-27 拍板）──
// 语义正确：它替代的就是那段历史，模型按时间顺序读天然接得上。
// 代价：每次压缩会把「summary/compact 之后的前缀缓存」破一次 —— 摊销到两次压缩之间的几十上百步，
// 约 $0.0001/步（可忽略）；而每轮都破一次（曾经的 `history:` 注记）才是灾难。
//
// ── 两种模式（`history.limit.summary.mode`，用户要对比效果）──
//   `model` —— 压缩时调一次模型，把被压段压成结论（`summary:` 段 + `text:`），模型开局直接读；
//   `self`  —— **不调用模型**，只给「压缩事实 + 原文位置 + 检索命令 + 要产出什么」，让它自己查。
//
// ── 头部不变量（务必守住）──
// 这条消息在**两次压缩之间必须逐字节不变**：里面只许放"压缩那一刻定下的事实"
// （时间 / 丢了多少 / 行号区间 / 文件路径），**不许**放"每轮都会变的量"（窗口占用、上一步花费、
// 当前时间……）。那些量一律去尾部 `runtime:` / `runtimeDiff:`。反例见 ##266：`history:` 注记的
// `kept` 右端点每轮 +N，导致每轮首步只有 8k token 命中、其余 120k 全价。
//
// 纯函数：禁止 import node:*（真发 / 预览 / 单测共用同一份）。

import { toYaml } from "./render";

/** 压缩事实：压缩那一刻定下、之后不再变的一组数 */
export interface CompactFacts {
    /** 压缩时刻（ISO） */
    at: string;
    /** 丢掉的**消息条数**（= llm.jsonl 行数；名字带单位，别叫 `dropped`） */
    droppedMessages: number;
    /** 被丢掉的**行号区间**（1-based，含两端；行号 == 消息序号） */
    lines: { from: number; to: number };
    /** llm.jsonl 绝对路径（每行一条消息） */
    source: string;
    /** 行号 → 字节偏移的索引文件（`tail -c +off <source>` = O(1) 取行；##442） */
    index?: string;
    /** turns.jsonl 绝对路径（每行一轮：turnId / 时间 / 用户那句话 / 我这一轮说了什么） */
    turns?: string;
    /**
     * 文件里**最长的一行**多少字节（266 实测 9.98 MB）。
     * 为什么必须给：单行整段取出来会直接撑爆上下文 ⇒ 模型据此决定"先 `head -c` 截断"。
     */
    maxLineBytes?: number;
}

/** `model` 模式：结论正文（由压缩时那次模型调用产出） */
export interface SummaryHeaderInput extends CompactFacts {
    /** 结构化摘要渲染后的 markdown（`summary.md` 模版） */
    text: string;
}

/** `self` 模式：不摘要，只给检索指令 */
export type SelfHeaderInput = CompactFacts;

/** 给人读的千分位（**只用于叙述文字**；命令行参数一律用原数 —— 逗号进 shell 会变成"多列地址"） */
const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * `model` 模式的消息正文：`summary:` 一段（结论 + 出处）。
 *
 * 为什么还留 `source` / `lines`：dsh 的 checkpoint 是自足的（不留出处），但 diy 的会话原文一直可查
 * ——多给几十字节就多一条"结论不够时自己深挖"的退路。
 */
export function renderSummaryHeader(i: SummaryHeaderInput): string {
    return toYaml({
        summary: {
            at: i.at,
            droppedMessages: i.droppedMessages,
            lines: { from: i.lines.from, to: i.lines.to },
            source: i.source,
            text: i.text,
        },
    });
}

/**
 * `self` 模式的消息正文：`compact:`（事实）+ `task:`（检索指令）。
 *
 * `task:` 的措辞是**契约**（模型照着做，所以要具体到命令、要具体到"写什么"）：
 *   ① 先查再干；② 按轮找比按行扫便宜；③ 取行必须**先量长度再截断**；
 *   ④ 产出四类：结论 / 决策 / 未完成 / 踩坑；⑤ 不许抄原文、宁可写"不知道"。
 */
export function renderSelfHeader(i: SelfHeaderInput): string {
    const { from, to } = i.lines;
    const seek = i.index ? `tail -c +$(( $(sed -n "\${N}p" ${i.index}) + 1 )) ${i.source} | head -c 4000` : null;
    const task = [
        `上面的对话被压缩掉了（第 ${fmt(from)}–${fmt(to)} 行，共 ${fmt(i.droppedMessages)} 条消息）。`,
        "原始记录里**每行是一条消息**，行号就是序号。先查再干活：",
        "",
        "① 按轮找线索（比按行扫便宜；每行一轮：turnId / 时间 / 用户那句话 / 我这一轮说了什么）",
        i.turns ? `   grep -n -m 5 '<关键词>' ${i.turns}` : "   （turns.jsonl 路径见上，按关键词 grep）",
        "",
        "② 取某一条消息的原文 —— **必须先截断**（单行可能几 MB，整段取会撑爆上下文）",
        seek
            ? `   ${seek}   # N = 行号，O(1)\n   sed -n '${from},${to}p' ${i.source} | head -c 8000   # 按区间扫（慢，但认得全文）`
            : `   sed -n '<N>p' ${i.source} | head -c 4000\n   sed -n '<N>p' ${i.source} | wc -c      # 先量长度`,
        i.maxLineBytes
            ? `   ⚠️ 这个文件里最长的一行有 ${fmt(i.maxLineBytes)} 字节 —— 直接 sed 不截断会一次灌满窗口。`
            : "   ⚠️ 单行可能很长：直接 sed 不截断会一次灌满窗口。",
        "",
        "③ 查完先写一份**当前状况**，再继续干活。要写的四类：",
        "   - 结论：已经确定的事实（谁 / 什么 / 为什么）",
        "   - 决策：定了什么、为什么这么定",
        "   - 未完成：下一步该做什么",
        "   - 踩坑：试过但不对的路，别重走",
        "   一行一句，不许抄原文段落；不知道就写不知道，不要编。",
    ].join("\n");
    return toYaml({
        compact: {
            at: i.at,
            droppedMessages: i.droppedMessages,
            lines: { from, to },
            ...(i.maxLineBytes ? { maxLineBytes: i.maxLineBytes } : {}),
            source: i.source,
            ...(i.index ? { index: i.index } : {}),
            ...(i.turns ? { turns: i.turns } : {}),
        },
    }) + "\n" + toYaml({ task });
}

/** 按模式渲染头部消息（`none` 不该出现：压掉必须有替身） */
export function renderCompactHeader(
    mode: "model" | "self",
    i: SummaryHeaderInput | SelfHeaderInput,
): string {
    return mode === "model" && "text" in i ? renderSummaryHeader(i) : renderSelfHeader(i as SelfHeaderInput);
}
