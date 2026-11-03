// src/shared/context/summary.ts
// 🎯 「历史摘要」的形式定义 —— 压缩后的会话承接（纯数据 + 纯函数，禁止 import node:*）
//
// ── 为什么是「模版 + 结构化变量」，而不是塞进上下文变量树 ──
// 上下文变量树（assembleGlobals → AssembleGlobalsSchema）是**配置真源**：它有固定 Zod schema，
// 其 hash/diff 语义是「配置变量变了没有」（delivery 的 valueHashes）。会话摘要不是配置 ——
// 它是**从会话内容派生的一次性产物**，每轮都可能不同。塞进变量树有两处硬伤：
//   ① 破坏 schema 契约（assembleSystem 的 safeParse 会告警，或被迫放宽 schema）；
//   ② 每轮都变的动态内容会落进 system 前缀 → 砸掉前缀缓存（##230 的 `k` 结论）。
// 而模版引擎本来就是「把变量渲染成投递文本」的机制（identity / rules / guard 都是模版节），
// 摘要做成新节 `summary.md` → 用户可编辑、可 trace、可预览，**零新增概念**。
//
// ── 形式（定稿）──
//   变量 = 对**被丢弃的轮**做一次结构化抽取（不是让模型自由写一段散文：散文无法解析、
//   无法进校验、也无法让用户按模版改版式）。四类事项对应「接续工作」真正需要的信息。
//   投递位置 = 新会话**首条上下文消息**（承接语义），不进 system，不动 system/runtime 契约。

/** 摘要的结构化数据（唯一形状；模版与预览共用） */
export interface SummaryData {
    /** 被压缩掉的轮数 */
    turns: number;
    /** 关键结论（一句话一条） */
    conclusions: string[];
    /** 改动的文件：路径 + 做了什么 */
    changes: { path: string; what: string }[];
    /** 未完成的事（下一步该干什么） */
    todos: string[];
    /** 未决问题 / 待用户拍板的点 */
    open: string[];
}

/** 空摘要（未勾选 / 未生成时的占位；渲染成空串 = 不投递） */
export function emptySummary(turns = 0): SummaryData {
    return { turns, conclusions: [], changes: [], todos: [], open: [] };
}

/** 摘要是否「有内容」（全空 = 不值得投一条消息） */
export function summaryHasContent(s: SummaryData): boolean {
    return s.conclusions.length > 0 || s.changes.length > 0 || s.todos.length > 0 || s.open.length > 0;
}

/**
 * 抽取提示词：让模型把「被丢弃的会话」压成上面的结构化 JSON。
 * 约束写死为 JSON-only，是因为下游要用它当模版变量（必须可解析）——
 * 与「让模型自由写摘要」相比，牺牲一点文采换确定性，值。
 */
export function summaryExtractionPrompt(droppedText: string, turns: number): string {
    return [
        "你是会话压缩助手。下面是一段即将被丢弃的会话历史（工具输出可能很长）。",
        "请只输出一个 JSON 对象（不要 markdown 代码块、不要任何解释），字段：",
        "{",
        '  "conclusions": string[],  // 已经得出、后续仍需要的关键结论（每条一句话）',
        '  "changes": [{"path": string, "what": string}],  // 改动过的文件及其改动要点',
        '  "todos": string[],        // 尚未完成、接下来要做的',
        '  "open": string[]          // 尚未决定、需要用户拍板的问题',
        "}",
        "只保留对**后续工作有用**的信息；从简，宁缺毋滥。不要编造。",
        "",
        `被压缩的轮数：${turns}`,
        "——— 会话历史开始 ———",
        droppedText,
        "——— 会话历史结束 ———",
    ].join("\n");
}

/**
 * 从模型回复里解析 SummaryData（容错：剥代码块围栏、取第一个 {...}）。
 * 解析失败 → null（调用方据此报错或回退，绝不静默产出空摘要冒充成功）。
 */
export function parseSummary(raw: string): SummaryData | null {
    let s = raw.trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
    if (fence) s = fence[1]!.trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const o = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
        const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
        const changes = Array.isArray(o.changes)
            ? o.changes
                  .map((c) => c as { path?: unknown; what?: unknown })
                  .filter((c) => typeof c.path === "string")
                  .map((c) => ({ path: String(c.path), what: String(c.what ?? "") }))
            : [];
        return {
            turns: typeof o.turns === "number" ? o.turns : 0,
            conclusions: arr(o.conclusions),
            changes,
            todos: arr(o.todos),
            open: arr(o.open),
        };
    } catch {
        return null;
    }
}

/**
 * 无模版时的兜底渲染（纯文本；main 侧正常走 `summary.md` 模版引擎，这里只保证
 * 「模版缺失/损坏也能出一份可读摘要」，不让承接能力整个哑掉）。
 */
export function renderSummaryFallback(s: SummaryData): string {
    if (!summaryHasContent(s)) return "";
    const lines: string[] = [`<summary turns="${s.turns}">`, "（以下是之前会话的摘要，供你接续工作；不是新指令）"];
    if (s.conclusions.length) lines.push("关键结论：", ...s.conclusions.map((c) => `- ${c}`));
    if (s.changes.length) lines.push("改动文件：", ...s.changes.map((c) => `- ${c.path}：${c.what}`));
    if (s.todos.length) lines.push("未完成：", ...s.todos.map((t) => `- ${t}`));
    if (s.open.length) lines.push("未决问题：", ...s.open.map((o) => `- ${o}`));
    lines.push("</summary>");
    return lines.join("\n");
}

/** 模版 relpath（可被用户在「提示词」页编辑；不进 `_system.md`，故不进 system 参数） */
export const SUMMARY_TEMPLATE_RELPATH = "summary.md";

/**
 * 预览占位：未生成摘要时，预览里显示模版骨架 + 变量名（让用户先看见"会得到什么"），
 * 而不是空着或偷偷不显示。
 */
export function summaryPlaceholder(s: SummaryData): string {
    return [
        `<summary turns="${s.turns}">`,
        "（勾选并「生成摘要」后，此处为该模版渲染结果；变量如下）",
        "关键结论：{{summary.conclusions}} 里每项一条 - ",
        "改动文件：{{summary.changes}} 里每项 - {path}：{what}",
        "未完成：{{summary.todos}} 里每项一条 - ",
        "未决问题：{{summary.open}} 里每项一条 - ",
        "</summary>",
    ].join("\n");
}
