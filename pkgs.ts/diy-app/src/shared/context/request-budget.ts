// src/shared/context/request-budget.ts
// 🎯 「agent 大脑」的**账本**：一条真发请求 → 它的脑容量都花在哪了（段 → 字节），
//    以及多步之间「哪些步值得看一眼」。
//
// 为什么单独一份而不再塞进 step-request.ts：
//   step-request 回答「模型看到了什么」（逐条消息），本文件回答「这些字节是谁付的」
//   （按**可减性**分组：system 链 / help / runtime 投影 / 历史重发 / 本轮输入）。
//   两者是同一份 messages 的两种投影，缺一不可：只看得见消息就不知道谁在吃预算。
//
// 判据（用户 2026-10-23）：
//   · 段的分组口径是「谁生成的、能不能减」，**不是**「在哪个容器里」——
//     大桶（system / runtime）永远看不出该砍谁；
//   · 「大脑」是跨维度的（预算 × 材料 × 时间），所以本文件只出**数据**，不碰 UI 语义。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import type { StepMessage } from "./step-request";

/** 一段（可独立决定去留的最小单位） */
export interface MindSegment {
    /** 展示名（`chain · ~/AGENTS.md` / `runtime.facts` / `历史 · tool`） */
    key: string;
    /** 分组：谁生成的、能不能减 */
    group: MindGroup;
    bytes: number;
    chars: number;
    /** 该段原文（点开看的就是它；不再回查流量日志，避免"看到的和量的不是同一份"） */
    text: string;
}

export type MindGroup = "system" | "runtime" | "history" | "input" | "help" | "tools";

/** 一层的块（YAML 文本切出来的） */
export interface MindBlock {
    key: string;
    text: string;
}

/**
 * 按「恰好 `indent` 个空格的 `key:` 行」把一段 YAML 文本切成块。
 *
 * 为什么按缩进而不用 YAML 解析器：
 *   1. 信封是**文本**（emitYaml 的产物），要量的是「真发出去的那几个字节」，
 *      解析成对象再序列化回来必然差值（"量的是不是我发的那份"就说不清了）；
 *   2. 内核零依赖（renderer 也 import 它）。
 *
 * **块标量（`key: |` / `|-`）必须跟踪**：它的正文里可以有任意缩进、甚至 `word:` 形状的行，
 * 不跟踪就会把正文里的行误当成新块（值被切碎、字节数凭空多出来）。
 */
export function splitYamlBlocks(text: string, indent: number): MindBlock[] {
    const out: MindBlock[] = [];
    let cur: string[] | null = null;
    let name = "";
    /** 当前块标量的父键缩进（null = 不在块标量里） */
    let scalarParent: number | null = null;
    const lead = (s: string): number => {
        let n = 0;
        while (n < s.length && s[n] === " ") n++;
        return n;
    };
    for (const line of text.split("\n")) {
        const ind = lead(line);
        if (scalarParent !== null) {
            // 块标量持续到「缩进回落到父键缩进或更浅」为止（空行不退出）
            if (line.trim() !== "" && ind <= scalarParent) scalarParent = null;
            else {
                cur?.push(line);
                continue;
            }
        }
        const isKey = ind === indent && /^\s*(?:- )?[A-Za-z_][\w.$*-]*:(\s|$)/.test(line);
        if (isKey) {
            if (cur) out.push({ key: name, text: cur.join("\n") });
            const s = line.trim();
            const isList = s.startsWith("- ");
            const body = isList ? s.slice(2) : s;
            const colon = body.indexOf(":");
            const head = body.slice(0, colon);
            const rest = body.slice(colon + 1).trim();
            // 列表项（`- path: ~/AGENTS.md`）用**值**作名字（chain 的每个文件一段）
            name = isList && rest !== "" ? rest.replace(/^["']|["']$/g, "") : head;
            cur = [line];
            if (/^[|>][-+]?$/.test(rest)) scalarParent = indent;
        } else {
            cur?.push(line);
        }
    }
    if (cur) out.push({ key: name, text: cur.join("\n") });
    return out;
}

/** UTF-8 字节数（与真发字节同口径） */
export function utf8Bytes(s: string): number {
    return new TextEncoder().encode(s).length;
}

/** 信封顶层键 → 分组（不在表里 = 没有信封结构，按角色归组） */
const ENVELOPE_GROUP: Record<string, MindGroup> = {
    help: "help",
    system: "system",
    runtime: "runtime",
    runtimeDiff: "runtime",
    summary: "history",
    history: "history",
    user: "input",
};

/** 看出这是一份信封（含顶格的信封键） */
function envelopeKeys(text: string): string[] {
    return splitYamlBlocks(text, 0).map((b) => b.key);
}

/**
 * 一组消息 → 段账。
 *
 * 粒度停在哪由「能不能独立决定去留」定：
 *   · `system.chain` 拆到**每个 AGENTS.md**（那份文件删不删是独立决定）；
 *   · `runtime` 拆到**二级键**（facts / kb / identity / task / room 各自有 expose 档位）；
 *   · 历史与工具结果按**角色**分桶（它们没有内部结构可言，减法是截断/摘要）。
 */
export function analyzeMind(messages: readonly StepMessage[]): {
    segments: MindSegment[];
    totalBytes: number;
    byGroup: Record<MindGroup, number>;
} {
    const segments: MindSegment[] = [];
    const push = (key: string, group: MindGroup, text: string): void => {
        segments.push({ key, group, bytes: utf8Bytes(text), chars: text.length, text });
    };
    for (const m of messages) {
        // 角色 → 兜底分组（信封能拆则改写）
        const roleGroup: MindGroup = m.role === "system" ? "system" : m.role === "user" ? "input" : "history";
        const blocks = envelopeKeys(m.text);
        const isEnvelope = blocks.some((k) => k in ENVELOPE_GROUP);
        if (!isEnvelope) {
            // 前缀按**分组**取，不按角色写死：user 的消息算 input（本轮输入）还是 history
            // 由上面的 roleGroup 判过 —— 标签再写死「历史」就会与计数互相矛盾。
            // 实测：`历史 · user 18759 B` 出现在 input 组下，读的人第一反应是分组算错了。
            const prefix = roleGroup === "input" ? "输入" : roleGroup === "system" ? "system" : "历史";
            const label =
                m.role === "assistant" ? "历史 · assistant（含工具调用参数）" : `${prefix} · ${m.role}`;
            push(label, roleGroup, m.text);
            continue;
        }
        for (const b of splitYamlBlocks(m.text, 0)) {
            const g = ENVELOPE_GROUP[b.key] ?? "other" as MindGroup;
            if (b.key === "system") {
                // system 段：chain 拆到每个文件，其余顶层键各一段
                for (const sub of splitYamlBlocks(b.text, 2)) {
                    if (sub.key === "chain") {
                        const files = splitYamlBlocks(sub.text, 4);
                        if (files.length === 0) push("system.chain", "system", sub.text);
                        for (const f of files) push(`chain · ${shortPath(f.key)}`, "system", f.text);
                    } else {
                        push(`system.${sub.key}`, "system", sub.text);
                    }
                }
            } else if (b.key === "runtime" || b.key === "runtimeDiff") {
                // 二级键各一段（facts / kb / identity / task / room …）
                for (const sub of splitYamlBlocks(b.text, 2)) push(`${b.key}.${sub.key}`, "runtime", sub.text);
            } else {
                push(b.key, g, b.text);
            }
        }
    }
    const byGroup = { system: 0, runtime: 0, history: 0, input: 0, help: 0, tools: 0 } as Record<MindGroup, number>;
    for (const s of segments) byGroup[s.group] += s.bytes;
    return { segments, totalBytes: segments.reduce((n, s) => n + s.bytes, 0), byGroup };
}

/**
 * 一段「为什么被发出去」的归因。
 *
 * 判据（用户 2026-10-23）：「大脑里为啥要发送某些数据，没有体现出来」——
 * 字节账只说「谁吃得多」，不回答「它凭什么在这里」。三件事缺一不可：
 *   · `place`  在哪个容器（system 参数 / 尾部 user 信封 / 历史回放）
 *   · `kind`   这份是**怎么来的**（首步全量 / 轮中变化 / 全量重建）—— 决定它该不该被减
 *   · `reason` 为什么**归这个容器**（真源 = `delivery.ts` 的 `PLACE_CANDIDATES.reason`）
 */
export interface SegmentWhy {
    place: "system" | "runtime" | "input" | "history" | "help";
    kind: "首步全量" | "轮中变化" | "全量重建" | "结构说明" | "用户原话" | "历史回放";
    reason: string;
}

/**
 * 段 key → 投递归因。
 *
 * `reasons` 由调用方传（= `PLACE_CANDIDATES` 的 path→reason）：本文件不 import delivery，
 * 避免「数据层反向依赖投递装配」；传空表也能用（只缺那句 reason）。
 */
export function explainSegment(key: string, reasons: Record<string, string> = {}): SegmentWhy {
    const pick = (p: string): string => reasons[p] ?? reasons[p.split(".")[0] ?? ""] ?? "";
    if (key === "help") {
        return { place: "help", kind: "结构说明", reason: "由 zod 递归派生（envelope.buildHelpDoc）；system 参数每次请求全量重建" };
    }
    if (key.startsWith("chain · ")) return { place: "system", kind: "全量重建", reason: pick("chain") };
    if (key.startsWith("system.")) return { place: "system", kind: "全量重建", reason: pick(key.slice(7)) };
    if (key.startsWith("runtimeDiff.")) return { place: "runtime", kind: "轮中变化", reason: pick(key.slice(12)) };
    if (key.startsWith("runtime.")) return { place: "runtime", kind: "首步全量", reason: pick(key.slice(8)) };
    if (key.startsWith("输入 · ")) {
        return { place: "input", kind: "用户原话", reason: "用户本轮真话（原样）；自动生成的段各有自己的顶层键" };
    }
    if (key === "summary" || key === "history") {
        return { place: "history", kind: "历史回放", reason: "自动生成的元数据（摘要 / 压缩注记），不是变量树" };
    }
    return { place: "history", kind: "历史回放", reason: "" };
}

/**
 * 与上一步**逐字相同**的段（按 key 对齐，比 text 不比 bytes —— 同字节不同内容是可能的）。
 *
 * 用途：回答「这次到底有什么变化」。`runtime.*` 段在这里出现，就等于「这一份是纯重发」——
 * 每轮首步都会重发全量 runtime（上一轮那份不在历史里，见 envelope.ts 头注），
 * 这是**设计后果**而不是重复发送；但哪几个单元真的变了，必须看得见。
 */
export function unchangedSegments(
    cur: readonly MindSegment[],
    prev: readonly MindSegment[] | undefined,
): MindSegment[] {
    if (!prev) return [];
    const m = new Map(prev.map((s) => [s.key, s.text]));
    return cur.filter((s) => m.get(s.key) === s.text);
}

/** 路径太长就掐头（保留末尾两级，人认的是文件名而非前缀） */
function shortPath(p: string): string {
    if (p.length <= 52) return p;
    return `…${p.slice(-50)}`;
}

/** 一段历史里的一条「重复读」信号 */
export interface RepeatSignal {
    /** 重复的东西（工具名 + 参数预览，或工具结果的首行） */
    what: string;
    /** 出现次数 */
    times: number;
    /** 出现在哪些步（1 起） */
    steps: number[];
}

/**
 * 重复读：同一步里相同 `工具 + 参数` 被调了多次，或**同一结果**在历史里出现多次。
 *
 * 为什么只报「同一参数」：参数不同就是不同的活儿（`rg a` 与 `rg b`），报它等于把正常工作算成异常；
 * 而 `sed -n 1,200p x.ts` 连调两次没有任何理由——那才是协调故障（重试没接上、上下文丢了）。
 */
export function repeatReads(steps: readonly { step: number; toolCalls: readonly { name: string; argsPreview: string }[] }[]): RepeatSignal[] {
    const seen = new Map<string, number[]>();
    for (const s of steps) {
        for (const c of s.toolCalls) {
            const k = `${c.name} ${c.argsPreview}`;
            const list = seen.get(k);
            if (list) list.push(s.step);
            else seen.set(k, [s.step]);
        }
    }
    return [...seen.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([what, steps]) => ({ what, times: steps.length, steps }))
        .sort((a, b) => b.times - a.times);
}

/**
 * 多步之间「值得看一眼」的形态：脑容量怎么长起来的。
 *
 * 判据只看**形态**（不看内容质量）：内容质量是另一把尺（`score`），混在一起就说不清
 * 「是模型变笨了」还是「材料变多了」。
 */
export interface MindTrend {
    steps: { step: number; reqBytes: number; historyBytes: number; systemBytes: number; runtimeBytes: number }[];
    /** 历史占比首次超过 70% 的步（没有则 null） */
    historyHeavyAt: number | null;
    /** 最后一步的历史占比（0~1） */
    historyShare: number;
}

export function mindTrend(
    steps: readonly { step: number; reqBytes: number; byGroup: Record<MindGroup, number> }[],
): MindTrend {
    const list = steps.map((s) => ({
        step: s.step,
        reqBytes: s.reqBytes,
        historyBytes: s.byGroup.history,
        systemBytes: s.byGroup.system,
        runtimeBytes: s.byGroup.runtime,
    }));
    const share = (s: { historyBytes: number; reqBytes: number }): number => (s.reqBytes > 0 ? s.historyBytes / s.reqBytes : 0);
    const heavy = list.find((s) => share(s) > 0.7);
    return {
        steps: list,
        historyHeavyAt: heavy ? heavy.step : null,
        historyShare: list.length > 0 ? share(list[list.length - 1]!) : 0,
    };
}
