// src/shared/context/compaction.ts
// 🎯 「压缩会话上下文」—— 策略 / 工具输出裁剪 / 事件账本 / 边界求值（纯函数，禁止 import node:*）
//
// 为什么单独一个文件、且必须是纯模块：
//   · main 要用它决定「投递哪些块」（blocksToMessages 的裁剪闭包）；
//   · renderer 要用它做**预览页**（当前会话 vs 压缩后 diff）与历史代列表 —— 预览不能靠 RPC
//     往返（每次拉滑条都打一次主进程），只能靠同一份纯函数在渲染层现算；
//   · 两边共用同一份实现，才能保证「预览看到的」就是「真发出去的」（##227 数字可信的同一条原则）。
//
// ── 三层概念（务必区分，混了就出错）──
//   ① 策略 CompactPolicy      —— 用户拧的旋钮（保留几轮 / 工具输出怎么处理 / 算不算摘要）
//   ② 事件 CompactLogEvent    —— append-only 的账（`<key>.compact.jsonl`）：压过几次、边界在哪、
//                                每次前后规模多大、事后实测如何（供将来算账，不改历史行）
//   ③ 边界 Boundary           —— 由事件账本推出的**当前生效**起点（keptFromTurnId）
//
// 存储布局的关键取舍：**旧日志原地不动**。压缩只写一条账（边界），不搬文件、不 rm。
//   为什么：ops.jsonl 是会话唯一权威（重放即块树），搬走它就得维护「归档目录 + 索引 + 迁移」；
//   而「生效边界」本来就是一个纯逻辑量 —— 记下来就够了。旧内容因此天然可查、可撤销（undo），
//   「彻底删除」仍归现有 clear（物理删文件）。

import { z } from "zod";

// ─── ① 策略 ───────────────────────────────────────────

/** 工具输出的处理方式（只作用于**投递**，UI 与落盘永远保留原文） */
export type ToolResultMode =
    /** 原样（不裁） */
    | "asis"
    /** 头尾裁剪：保留前 N 行 + 后 M 行，中间写 marker（原文可寻回） */
    | "headtail"
    /** 只留调用 + 路径：整段输出换成一句指向原文的提示 */
    | "callpath";

/** 头尾裁剪参数（默认值来自 ##230 会话实测定，勿凭感觉改） */
export interface HeadTailPolicy {
    /**
     * 超过多少行才裁。**由 head+tail 推出**（不再单列输入项）：前 3 后 3 → 超过 6 行才裁。
     * 保留此字段只为读取与展示方便（落盘账本里也写明白当时用的是多少）。
     */
    triggerLines: number;
    /** 保留头部行数 */
    headLines: number;
    /** 保留尾部行数 */
    tailLines: number;
    /** 单行超长（压缩 JSON 之类）截断阈值（字符） */
    maxLineChars: number;
    /** 保留总量兜底（字节）：超了就按比例再收，防「一行超长」钻空子 */
    maxKeepBytes: number;
}

/**
 * 默认头尾裁剪参数：**保留前 3 行 + 后 3 行，超过 6 行即裁**。
 * 依据（本机 20,965 条 tool 输出实测）：p50=9 行 / p90=64 行；默认阈值取小，覆盖面更广
 * （绝大多数输出在 6 行以内 → 原样；长输出则一律裁成头 3 + 尾 3 + marker）。
 */
export const DEFAULT_HEADTAIL: HeadTailPolicy = {
    triggerLines: 6,
    headLines: 3,
    tailLines: 3,
    maxLineChars: 300,
    maxKeepBytes: 8192,
};

/** 默认保留轮数（用户可在 panel 里调；「全部清零」是另一支 `mode:"reset"`，不是 `count:0`） */
export const DEFAULT_KEEP_TURNS = 6;

// ─── 策略：一棵**决策树**（用户 2026-10-06 二次定稿）───────────────────
//
// 演进：扁平兄弟字段（##267）→ 三轴 + 私有参数进分支（D3a，只治了最深一层）
//       → **按从属关系建模的决策树**（现在）。
//
// 为什么还要再进一步：三轴虽把 `headtail` 收进了 `toolResult` 分支，但三条轴**本身仍是平级兄弟** ——
// 于是 `mode:"reset"`（清零）时 `keep.unit` / `content` / `toolResult` 全是**死字段**
// （清零已无内容可裁），读 YAML 的人无从知道「这个字段属于哪一支、什么时候才生效」。
// 决策树把这一点编进**结构**：每层的私有参数收进该层分支 ⇒ **非法组合不可表达**
// （清零不可能带 toolResult），读结构即知语义（D5「结构即语义」）。
//
// 层级：① 模式（清零 / 保留）→ ② 范围（最近 N / 全部轮次）→ ③ 内容（含不含工具链路）
//       → ④ 工具结果怎么裁（**只在「含工具链路」这一支里**）
// `summary` 不在树上：清零与保留**都**能算摘要 ⇒ 放进树里就得每支重复一个同名字段。

/**
 * ④ 工具**结果**轴：判别式联合，参数收进分支（看 JSON 即知关系）。
 *
 * 名字为什么是 `toolResult` 而不是 `toolOutput`（用户 2026-10-06）：
 * 「output」与 provider 的 input/output token 撞词，读 JSON 时分不清是"工具产出的文本"
 * 还是"输出 token 数"；而 provider 的 part 类型本就叫 `tool-result` —— 用同一个词，零歧义。
 * 判别键同理：`render`（这条工具结果**怎么呈现给模型**）比 `mode` 具体。
 */
export const ToolResultPolicySchema = z.discriminatedUnion("render", [
    z.object({ render: z.literal("asis").describe("原样（不裁）") }),
    z.object({
        render: z.literal("headtail").describe("头尾裁剪：保留前 head 行 + 后 tail 行，中间写 marker"),
        head: z.number().describe("保留头部行数"),
        tail: z.number().describe("保留尾部行数"),
        maxLineChars: z.number().describe("单行超长截断阈值（字符）"),
        maxKeepBytes: z.number().describe("保留总量兜底（字节），防「一行超长」钻空子"),
    }),
    z.object({ render: z.literal("callpath").describe("只留调用 + 原文路径") }),
]);

/**
 * ③ 内容轴：留过程还是只留结论 —— **工具结果的裁法是这一支的私有参数**（只有「含工具链路」才谈得上怎么裁）。
 */
export const ContentPolicySchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("all").describe("保留工具链路（用户 / 助手文本 + 工具调用与结果）"),
        toolResult: ToolResultPolicySchema,
    }),
    z.object({ kind: z.literal("text").describe("只留文本：去掉工具调用与结果") }),
    z.object({ kind: z.literal("conclusion").describe("只留结论：每轮只留最后一条助手文本") }),
]);

/** ② 范围轴：留多久（轮 = 安全单位，不会切开 tool-call/result 配对；消息条数会自动吸附到轮首） */
export const KeepPolicySchema = z.discriminatedUnion("scope", [
    z.object({
        scope: z.literal("all").describe("全留轮次（配合内容轴用：只裁内容、不裁轮）"),
    }),
    z.object({
        scope: z.literal("recent").describe("保留最近若干（单位见 unit）"),
        unit: z.enum(["turns", "messages"]).describe("保留单位：turns（轮，安全单位）或 messages（条数，自动吸附到轮首）"),
        // coerce：CLI 把选项当字符串传（`--keep-turns 1`）。**正数**约束把 0 挡在门外 ——
        // 0 的旧含义（全部清零）已升格成 `mode:"reset"`，留在这一支只会造出第二个真源。
        count: z.coerce.number().int().positive().describe("保留最近 N（N ≥ 1；「全部清零」是 mode=reset，不是 count=0）"),
    }),
]);

/** 「是否额外算一份历史摘要」——**两种模式都成立**，故不进决策树（见本区头注） */
const SummaryField = z.boolean().describe("是否额外算一份历史摘要带进新会话（额外调一次模型，花钱）");

/**
 * ① 模式轴：**清零** 还是 **保留**（顶层判别）。
 * `reset` 支没有范围 / 内容字段 —— 清零没有内容可裁，那些字段放进这一支全是死字段。
 */
/**
 * 【新 · 用户 2026-10-07 定稿】**目标式预算**：用户只给一个字节预算，系统按**纵向优先级
 * 阶梯**（user > 结论 > 非结论 > 工具命令 > 工具结果）保留到预算上限。
 *
 * 与旧决策树的区别（为什么弃用旧 UI）：
 *   · 旧的是「用户拧保留规则」（保留几轮 / 内容轴 / 工具结果裁法）—— 6+ 控件、认知负担重；
 *   · 新的是「用户给目标，系统定阶梯」—— 唯一输入 `budgetBytes`。工具结果的呈现（`toolResult`）
 *     降级为**系统内部旋钮**，不给用户拧。
 *
 * 语义：`budgetBytes` 是**除固定开支外**（system 容器 + 工具定义 + runtime 容器 + 当前轮 user
 * 消息）历史消息可占的字节上限；`0` ⇒ 等价清零。它按**字节**计（UTF-8），UI 里以 KB 显示。
 */
export const BudgetPolicySchema = z.object({
    mode: z.literal("budget").describe("目标式预算：按纵向优先级阶梯保留到预算上限"),
    budgetBytes: z
        .number()
        .int()
        .nonnegative()
        .describe("历史消息可占字节上限（不含固定开支）；0 = 清零"),
    toolResult: ToolResultPolicySchema.describe("工具结果在预算内的呈现（系统内部旋钮）"),
    summary: SummaryField,
});

/**
 * 策略真源（判别联合）：**budget**（新，唯一由 UI/CLI 产生）/ **reset** / **keep**（旧，仅供读取
 * 历史账本，保证老会话的压缩口径不失效 —— 这是正确性，不是兼容洁癖）。
 */
export const CompactPolicySchema = z.discriminatedUnion("mode", [
    BudgetPolicySchema,
    z.object({
        mode: z.literal("reset").describe("【旧】会话清零：本次压缩不投任何历史轮（日志一字不删）"),
        summary: SummaryField,
    }),
    z.object({
        mode: z.literal("keep").describe("【旧】保留部分历史（范围 / 内容 / 工具结果见下）"),
        keep: KeepPolicySchema,
        content: ContentPolicySchema,
        summary: SummaryField,
    }),
]);

export type KeepPolicy = z.infer<typeof KeepPolicySchema>;
export type ContentPolicy = z.infer<typeof ContentPolicySchema>;
export type ContentPolicyKind = ContentPolicy["kind"];
export type ToolResultPolicy = z.infer<typeof ToolResultPolicySchema>;
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;
export type CompactPolicy = z.infer<typeof CompactPolicySchema>;
export type CompactMode = CompactPolicy["mode"];

/** 默认预算：用户 2026-10-07 定的经验值 **3KB**（≈清零 —— 经验上清零也没啥大不了、还挺干净） */
export const DEFAULT_BUDGET_BYTES = 3 * 1024;

/** 预算缺省的工具结果呈现（头尾裁剪：长输出留头尾、中间省略，原文可回取） */
export const DEFAULT_TOOL_RESULT_POLICY: ToolResultPolicy = {
    render: "headtail",
    head: DEFAULT_HEADTAIL.headLines,
    tail: DEFAULT_HEADTAIL.tailLines,
    maxLineChars: DEFAULT_HEADTAIL.maxLineChars,
    maxKeepBytes: DEFAULT_HEADTAIL.maxKeepBytes,
};

/** 新策略真源（UI/CLI 的缺省）：3KB 预算 + 工具结果头尾裁剪 */
export const DEFAULT_COMPACT_POLICY: BudgetPolicy = {
    mode: "budget",
    budgetBytes: DEFAULT_BUDGET_BYTES,
    toolResult: DEFAULT_TOOL_RESULT_POLICY,
    summary: false,
};

// ── 决策树 → 选择 / 渲染阶段要用的三值（下游只认这三个，不认树）──

/** 内容轴的三值视图（预算 / 清零都无「内容轴」概念 → "all"；仅旧 keep 支有） */
export function contentKindOf(p: CompactPolicy): ContentPolicyKind {
    return p.mode === "keep" ? p.content.kind : "all";
}

/** 工具结果策略：预算支取 `toolResult`；旧 keep+all 支取 `content.toolResult`；其余 → null（不裁） */
export function toolResultOf(p: CompactPolicy): ToolResultPolicy | null {
    if (p.mode === "budget") return p.toolResult;
    return p.mode === "keep" && p.content.kind === "all" ? p.content.toolResult : null;
}

/**
 * 策略 → **字节预算**（`null` = 非预算策略，走旧的「轮边界 + 内容轴」投递路径）。
 * `reset` 视作预算 0（等价清零）。这是「预算」这条新路径的**唯一入口**。
 */
export function budgetBytesOf(p: CompactPolicy): number | null {
    if (p.mode === "budget") return p.budgetBytes;
    if (p.mode === "reset") return 0;
    return null;
}

/**
 * 扁平（**输入面**）形状：RPC / CLI / UI state 用的紧凑契约，**不是**真源形状。
 *
 * 为什么输入面可以继续扁平：UI 自己保证「只产生合法组合」（决策树按分支展开），
 * CLI 的 `--keep-turns / --content / --tool-result` 是给人用的快捷语法；
 * 而**真源**（账本 / auto-compact.yaml）必须是决策树 —— 那里要给人读、要自解释。
 * `normalizePolicy` 是唯一适配点（扁平/旧形状 → 树），`flatPolicyOf` 是反向（树 → 扁平，供 UI 回读）。
 */
export interface FlatCompactPolicy {
    /** 【新】目标式预算的字节上限（KB 由 UI 换算）；有它就按预算选择 */
    budgetBytes?: number;
    keepTurns: number | "all";
    toolResult: ToolResultMode;
    headtail: HeadTailPolicy;
    summary: boolean;
    content?: ContentPolicyKind;
    keepUnit?: "turns" | "messages";
}

/** 策略 → 扁平（UI 回读 / RPC 下发用） */
export function flatPolicyOf(p: CompactPolicy): FlatCompactPolicy {
    if (p.mode === "budget") {
        const tr = p.toolResult;
        const ht =
            tr.render === "headtail"
                ? { triggerLines: tr.head + tr.tail, headLines: tr.head, tailLines: tr.tail, maxLineChars: tr.maxLineChars, maxKeepBytes: tr.maxKeepBytes }
                : { ...DEFAULT_HEADTAIL };
        return {
            budgetBytes: p.budgetBytes,
            keepTurns: "all",
            toolResult: tr.render,
            headtail: ht,
            summary: p.summary,
            content: "all",
            keepUnit: "turns",
        };
    }
    if (p.mode === "reset") {
        return {
            keepTurns: 0,
            toolResult: "asis",
            headtail: { ...DEFAULT_HEADTAIL },
            summary: p.summary,
            content: "all",
            keepUnit: "turns",
        };
    }
    const k = p.keep;
    const tr = p.content.kind === "all" ? p.content.toolResult : ({ render: "asis" } as const);
    const ht =
        tr.render === "headtail"
            ? {
                  triggerLines: tr.head + tr.tail,
                  headLines: tr.head,
                  tailLines: tr.tail,
                  maxLineChars: tr.maxLineChars,
                  maxKeepBytes: tr.maxKeepBytes,
              }
            : { ...DEFAULT_HEADTAIL };
    return {
        keepTurns: k.scope === "all" ? "all" : k.count,
        toolResult: tr.render,
        headtail: ht,
        summary: p.summary,
        content: p.content.kind,
        keepUnit: k.scope === "recent" ? k.unit : "turns",
    };
}

const posNum = (v: unknown, d: number, min = 0): number =>
    typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : d;

/** 工具结果策略的宽松读（三种历史形状都收：`"headtail"` 字符串 / `{render,…}` / 更早的 `{mode,…}`） */
function readToolResult(raw: unknown, ht: Partial<HeadTailPolicy>): ToolResultPolicy {
    if (raw !== null && typeof raw === "object") {
        const o = raw as Record<string, unknown>;
        const m = o["render"] ?? o["mode"];
        if (m === "headtail") {
            return {
                render: "headtail",
                head: posNum(o["head"], DEFAULT_HEADTAIL.headLines, 0),
                tail: posNum(o["tail"], DEFAULT_HEADTAIL.tailLines, 0),
                maxLineChars: posNum(o["maxLineChars"], DEFAULT_HEADTAIL.maxLineChars, 1),
                maxKeepBytes: posNum(o["maxKeepBytes"], DEFAULT_HEADTAIL.maxKeepBytes, 1),
            };
        }
        return m === "callpath" ? { render: "callpath" } : { render: "asis" };
    }
    if (raw === "headtail") {
        return {
            render: "headtail",
            head: posNum(ht.headLines, DEFAULT_HEADTAIL.headLines, 0),
            tail: posNum(ht.tailLines, DEFAULT_HEADTAIL.tailLines, 0),
            maxLineChars: posNum(ht.maxLineChars, DEFAULT_HEADTAIL.maxLineChars, 1),
            maxKeepBytes: posNum(ht.maxKeepBytes, DEFAULT_HEADTAIL.maxKeepBytes, 1),
        };
    }
    if (raw === "callpath") return { render: "callpath" };
    return { render: "asis" };
}

/** 内容轴的宽松读（新 `{kind, toolResult}` / 旧 `"all"|"text"|"conclusion"` 都收） */
function readContent(raw: unknown, legacyToolResult: unknown, ht: Partial<HeadTailPolicy>): ContentPolicy {
    if (raw !== null && typeof raw === "object") {
        const o = raw as Record<string, unknown>;
        const kind = o["kind"];
        if (kind === "text") return { kind: "text" };
        if (kind === "conclusion") return { kind: "conclusion" };
        return { kind: "all", toolResult: readToolResult(o["toolResult"], ht) };
    }
    if (raw === "text") return { kind: "text" };
    if (raw === "conclusion") return { kind: "conclusion" };
    return { kind: "all", toolResult: readToolResult(legacyToolResult, ht) };
}

/**
 * 宽松校验：从 UI / CLI / 旧账本来的策略 → 合法**决策树**。
 *
 * 两类输入：
 *   · 决策树形状（现役，带 `mode`）→ 逐字段宽松归一；
 *   · **旧形状**（D3a 的三轴 `keep:{unit,count}` / ##267 的扁平 `keepTurns`）→ 迁移过来。
 *     为什么必须支持：`$DIY_HOME` 里**已有**老账本（compact.jsonl）存着旧 policy，读出来要能正确投递
 *     （否则老会话的压缩边界失效 → 请求内容错乱）。这是**正确性**，不是兼容洁癖。
 */
export function normalizePolicy(p: unknown): CompactPolicy {
    const src = (p ?? {}) as Record<string, unknown>;

    // ── 现役①：目标式预算（新；UI/CLI 产出的唯一形状）──
    // 判据：显式 `mode:"budget"` 或带 `budgetBytes`（扁平输入面传 budgetBytes 时会走这条）
    if (src["mode"] === "budget" || (src["budgetBytes"] !== undefined && src["mode"] === undefined)) {
        const bb = posNum(src["budgetBytes"], DEFAULT_BUDGET_BYTES, 0);
        const ht = (src["headtail"] ?? {}) as Partial<HeadTailPolicy>;
        return {
            mode: "budget",
            budgetBytes: bb,
            // 未显式给工具结果裁法 → 用缺省（头尾裁剪）。若不裁，大工具结果会一口吃掉预算。
            toolResult: src["toolResult"] !== undefined || ht.headLines !== undefined ? readToolResult(src["toolResult"], ht) : DEFAULT_TOOL_RESULT_POLICY,
            summary: src["summary"] === true,
        };
    }

    // ── 现役②：旧决策树（读历史账本用，不再由 UI 产生）──
    if (src["mode"] === "reset") return { mode: "reset", summary: src["summary"] === true };
    if (src["mode"] === "keep") {
        const k = (src["keep"] ?? {}) as Record<string, unknown>;
        return {
            mode: "keep",
            keep: k["scope"] === "all" ? { scope: "all" } : readRecent(k, src["keepUnit"]),
            content: readContent(src["content"], undefined, {}),
            summary: src["summary"] === true,
        };
    }

    // ── 旧形状迁移 ──
    const k = (src["keep"] ?? {}) as Record<string, unknown>;
    const ht0 = (src["headtail"] ?? {}) as Partial<HeadTailPolicy>;
    const rawCount = k["count"] ?? src["keepTurns"];
    const unit = k["unit"] === "messages" || src["keepUnit"] === "messages" ? "messages" : "turns";
    const numOf = (v: unknown): number | null => {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
        if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v);
        return null;
    };
    // ⚠️ 负数**不**夹成 0：0 的旧含义是「全部清零」，负数只可能是笔误/脏数据 ——
    //    把 -1 解成"清空会话"是灾难性误读，故一律回落缺省（6）。
    const n = numOf(rawCount);
    const summary = src["summary"] === true;
    const content = readContent(src["content"], src["toolResult"], ht0);
    if (rawCount === "all") return { mode: "keep", keep: { scope: "all" }, content, summary };
    if (n === 0) return { mode: "reset", summary }; // 旧 count:0 = 清零 → 升格成 mode
    return {
        mode: "keep",
        keep: { scope: "recent", unit, count: n ?? DEFAULT_KEEP_TURNS },
        content,
        summary,
    };
}

/** `{unit,count}`（现役 recent 支）的宽松读；unit 也接受来自扁平形状的 `keepUnit` */
function readRecent(k: Record<string, unknown>, legacyUnit: unknown): KeepPolicy {
    const unit = k["unit"] === "messages" || legacyUnit === "messages" ? "messages" : "turns";
    const n = typeof k["count"] === "number" && Number.isFinite(k["count"]) && k["count"] > 0 ? Math.floor(k["count"]) : DEFAULT_KEEP_TURNS;
    return { scope: "recent", unit, count: n };
}

/**
 * 策略 → 保留轮数（**唯一入口**：三种取法都在收口，免得每个调用点各写一遍而漏掉某一支）。
 *
 *   · mode = "reset"        → 0（全丢，会话硬切换）
 *   · scope = "all"         → 全留（轮数 = 全部）
 *   · scope = "recent"      → unit=turns 取 min(count, 总轮数)；unit=messages 见 keptTurnsByMessageCount
 */
export function keptTurnsOf(
    policy: CompactPolicy,
    turnIds: readonly string[],
    messageTurns: readonly string[],
): number {
    if (policy.mode === "reset") return 0;
    // 预算支：保留轮数取决于**实际字节**（要投影才知道），无法从 turn id 推出 —— 由调用方
    // （planCompact）用 selectHistoryByBudget 另行计数；这里不应被调用到。
    if (policy.mode === "budget") return turnIds.length;
    const k = policy.keep;
    if (k.scope === "all") return turnIds.length;
    if (k.unit === "turns") return Math.min(k.count, turnIds.length);
    return keptTurnsByMessageCount(messageTurns, k.count, turnIds);
}

/**
 * keep.unit=messages 的**安全吸附**：取最后 count 条消息，再退到该消息所在轮的**轮首**。
 *
 * 为什么不直接按条数切：轮内 tool-call 与 tool-result 必须成对（provider 拒单独一半）。
 * 退到轮首 ⇒ 保留量只会**多**不会少（少 = 凭空切开配对，历史直接被拒）。
 * count=0 → 全清；count ≥ 总条数 → 全留。
 */
export function keptTurnsByMessageCount(
    messageTurns: readonly string[],
    count: number,
    turnIds: readonly string[],
): number {
    if (count <= 0) return 0;
    if (count >= messageTurns.length || turnIds.length === 0) return turnIds.length;
    const firstKeptTurn = messageTurns[messageTurns.length - count]!;
    const i = turnIds.indexOf(firstKeptTurn);
    return i < 0 ? turnIds.length : turnIds.length - i; // 找不到 → 宁可全留
}

// ─── ② 工具输出裁剪（纯函数）────────────────────────────

const encoder = new TextEncoder();
/** UTF-8 字节数（token 与流量的口径都是字节，不是 character —— 中文一行 3 字节） */
export function utf8Bytes(s: string): number {
    return encoder.encode(s).length;
}

/** 人类可读字节数（marker 文案用） */
export function fmtBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
}

export interface ToolClipResult {
    /** 裁剪后文本（未裁时与输入逐字符相同） */
    text: string;
    clipped: boolean;
    origLines: number;
    origBytes: number;
    keptLines: number;
    keptBytes: number;
    droppedLines: number;
    droppedBytes: number;
}

export interface ClipOpts {
    /** 原文落盘的相对路径（marker 里写给模型/人看）；缺省则不写「见 …」 */
    origPath?: string;
}

/** 单行截断（只动超长行；短行原样，保证 marker 之外的文本与原文逐字符一致） */
function truncLine(line: string, max: number): string {
    return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 按策略裁一段工具输出。
 *
 * 设计要点：
 *   · **未触发裁条件时逐字符返回原文** —— 不"顺手规整"，否则 86% 不受影响的输出会和历史分叉；
 *   · 行数触发是主判据（阈值 ≈ p90），字节兜底只防"一行超长"（压缩 JSON / base64）；
 *   · marker 里**必须**给原文路径（##127 的「头尾保留 + marker + 原文可寻回」三件套），
 *     否则模型看到「中间省略」却无处可查，只能重跑一遍命令（那是真金白银）。
 */
export function clipToolResult(text: string, toolResult: ToolResultPolicy, opts: ClipOpts = {}): ToolClipResult {
    const origLines = text === "" ? 0 : text.split("\n").length;
    const origBytes = utf8Bytes(text);
    const same = (): ToolClipResult => ({
        text,
        clipped: false,
        origLines,
        origBytes,
        keptLines: origLines,
        keptBytes: origBytes,
        droppedLines: 0,
        droppedBytes: 0,
    });

    if (toolResult.render === "asis") return same();

    const lines = text.split("\n");
    const pathHint = opts.origPath ? `完整输出见 ${opts.origPath}` : "完整输出已省略";

    if (toolResult.render === "callpath") {
        if (text === "") return same();
        const marker = `[输出已省略（只留调用）：${origLines} 行 / ${fmtBytes(origBytes)}，${pathHint}]`;
        return {
            text: marker,
            clipped: true,
            origLines,
            origBytes,
            keptLines: 1,
            keptBytes: utf8Bytes(marker),
            droppedLines: origLines,
            droppedBytes: origBytes,
        };
    }

    // headtail（参数直接来自分支 —— 判别式联合的意义就在这：不必判"该不该有这些参数"）
    const ht = { triggerLines: toolResult.head + toolResult.tail, headLines: toolResult.head, tailLines: toolResult.tail, maxLineChars: toolResult.maxLineChars, maxKeepBytes: toolResult.maxKeepBytes };
    const overLines = origLines > ht.triggerLines;
    const overBytes = origBytes > ht.maxKeepBytes;
    const longLine = lines.some((l) => l.length > ht.maxLineChars);
    if (!overLines && !overBytes && !longLine) return same();
    // 行数没超、字节也没超，只是个别行超长 → 只做单行截断，不写「中间省略」marker（没省略任何行）
    if (!overLines && !overBytes) {
        const out = lines.map((l) => truncLine(l, ht.maxLineChars)).join("\n");
        return {
            text: out,
            clipped: true,
            origLines,
            origBytes,
            keptLines: origLines,
            keptBytes: utf8Bytes(out),
            droppedLines: 0,
            droppedBytes: 0,
        };
    }

    let headN = Math.min(ht.headLines, origLines);
    let tailN = Math.min(ht.tailLines, Math.max(0, origLines - headN));
    const build = (): string => {
        const head = lines.slice(0, headN).map((l) => truncLine(l, ht.maxLineChars));
        const tail = tailN > 0 ? lines.slice(origLines - tailN).map((l) => truncLine(l, ht.maxLineChars)) : [];
        const midStart = headN;
        const midEnd = origLines - tailN;
        const dropped = lines.slice(midStart, midEnd);
        const dBytes = utf8Bytes(dropped.join("\n"));
        const marker = `[... 中间省略 ${dropped.length} 行 / ${fmtBytes(dBytes)}，${pathHint} ...]`;
        return [...head, marker, ...tail].join("\n");
    };
    let out = build();
    // 字节兜底：按 4:1 的比例同步收缩 head/tail，直到进预算（至少各留… 头留 1 行、尾可为 0）
    while (utf8Bytes(out) > ht.maxKeepBytes && headN > 1) {
        headN = Math.max(1, headN - Math.max(1, Math.floor(headN / 4)));
        tailN = Math.max(0, Math.min(tailN, Math.floor(headN / 4)));
        out = build();
    }
    return {
        text: out,
        clipped: true,
        origLines,
        origBytes,
        keptLines: headN + tailN + 1,
        keptBytes: utf8Bytes(out),
        droppedLines: origLines - headN - tailN,
        droppedBytes: Math.max(0, origBytes - utf8Bytes(out)),
    };
}

/**
 * 由「策略 + 边界」构造**投递选项**中与裁剪有关的部分（纯函数，main 与 renderer 共用）。
 *
 * 为什么必须共用：预览页在 renderer 里现算（拉滑条不该每次打一次 RPC），真发在 main 里算；
 * 两者若各写一份 transform，就会出「预览说省 97%、真发却照旧」这种测不出来的分叉。
 * `origPathOf` 由调用方注入（main 用落盘相对路径，renderer 用同一字符串，不碰文件系统）。
 */
export interface DeliveryTransform {
    /** 【新·目标式预算】历史消息可占字节上限；有它就按纵向优先级阶梯选择，忽略 sinceTurnId/content */
    budgetBytes?: number;
    sinceTurnId?: string | null;
    /** 内容轴的三值：留过程还是只留结论（选择阶段的判据，见 local-blocks 的 selectHistory） */
    content?: ContentPolicyKind;
    transformToolResult?: (b: { id: string; tool: string; output: string }) => string;
}

/**
 * 注意三态语义（**极易踩**）：
 *   · keptFromTurnId = undefined → **全投**（无压缩；opts 里不带 sinceTurnId）
 *   · keptFromTurnId = null      → **全部清零**（opts.sinceTurnId = null）
 *   · keptFromTurnId = "t123"    → 自该轮起投
 * 把 undefined 与 null 混为一谈，会让「未压缩」被当成「清零」→ 请求变空（实测踩过）。
 */
export function makeDeliveryTransform(
    policy: CompactPolicy,
    keptFromTurnId: string | null | undefined,
    origPathOf: (id: string) => string,
    collect?: ClippedToolDetail[],
): DeliveryTransform {
    const opts: DeliveryTransform = {};
    const bb = budgetBytesOf(policy);
    if (bb !== null) {
        // 【新】预算口径：每次请求实时按预算选择（不管 sinceTurnId / 轮边界）—— 用户 2026-10-07
        opts.budgetBytes = bb;
    } else if (keptFromTurnId !== undefined) {
        // 【旧】轮边界口径（读历史账本用）
        opts.sinceTurnId = keptFromTurnId;
        const kind = contentKindOf(policy);
        if (kind !== "all") opts.content = kind;
    }
    // 工具结果的裁法**只有**「保留工具链路」这一支有（其余 → null）
    const tr = toolResultOf(policy);
    if (tr && tr.render !== "asis") {
        opts.transformToolResult = ({ id, output }) => {
            const r = clipToolResult(output, tr, { origPath: origPathOf(id) });
            if (!r.clipped) return output;
            collect?.push({
                id,
                tool: "",
                render: tr.render,
                origLines: r.origLines,
                origBytes: r.origBytes,
                keptLines: r.keptLines,
                keptBytes: r.keptBytes,
                origPath: origPathOf(id),
            });
            return r.text;
        };
    }
    return opts;
}

// ─── ③ 事件账本 ────────────────────────────────────────

/** 规模快照（前后对比 / 历史代列表共用） */
export interface SizeSnapshot {
    turns: number;
    messages: number;
    bytes: number;
    /** 估算 token（无 tokenizer，按字节/4 粗估；仅用于 panel 的「首屏估算」文案） */
    estTokens: number;
}

/** 单位成本快照：**按 provider 实算，不能写死**（同一模型各家 k 从 1x 到 50x，见 ##230） */
export interface RateSnapshot {
    /** **谁服务的**（实际调用的上游，如 zen-go）——与下面的 `source` 是两件事，别混 */
    provider?: string;
    /**
     * **价目真源**（如 `models.dev@2026-10-02`）。
     * 为什么要与 provider 分开：同一模型多家 provider 报价差到 1x~50x（##230 实测），
     * 只记 provider 说明不了"这个单价是从哪张表查的"；只记 source 则不知道请求实际走谁。
     */
    source?: string;
    model?: string;
    /** 全价（$/1M） */
    input: number;
    /** 缓存读价（$/1M） */
    cacheRead: number;
    /**
     * k = 全价 ÷ 缓存读价（回本公式的分子；k=50 → 砍一半要 49 步回本）。
     * ⚠️ 落盘前**必须圆整**：不做的话会出现 `50.00000000000001` 这种毛刺（实测），
     * 而它是给人看的账目数字，不是中间计算量 —— 精度越高越像 bug。
     */
    k: number;
    asOf?: string;
}

export interface CompactBoundaryRecord {
    /** 保留起点轮 id（label；null = 压缩那一刻全部清零） */
    keptFromTurnId: string | null;
    /**
     * **机械锚点**：压缩那一刻的 ops 下标 —— 只保留此下标之后的 op。
     *
     * 为什么必须有它：`keptFromTurnId` 为 null 时**表达不了"以后新产生的轮要保留"**。
     * 若只按 turn id 切，null 会被解读成"永远从空开始"→ 压缩后新发的消息（op 追加在文件尾）
     * 也被吞掉（UI 看不到、真发也不投 → 模型失忆）。用"压缩时刻的 op 下标"作锚，
     * 新的轮落在此下标之后因而天然保留（实测 bug：压缩后发的聊天消息全消失）。
     */
    keepFromOpIndex: number;
    /** 该轮 start 在 ops.jsonl 里的**字节偏移**（重放跳前缀的快路径；缺省则退化为全量重放） */
    keptFromOpsOffset?: number;
    keptTurns: number;
    droppedTurns: number;
}

/** 被丢弃的一轮：只存**摘要 + 指针**，全文留在 ops 原地（体积可控，且随时可回查） */
export interface DroppedTurnDetail {
    turnId: string;
    /** 该轮 start 的字节偏移 + 长度（回查原文的指针） */
    opsOffset: number;
    opsBytes: number;
    steps: number;
    textBytes: number;
    thinkBytes: number;
    tools: {
        id: string;
        tool: string;
        /** 调用摘要（截断到 200 字符；只为人读，不作判据） */
        argsBrief: string;
        outLines: number;
        outBytes: number;
        status: string;
    }[];
}

/** 被裁剪的工具输出明细（只对「保留部分」生效；原文落盘可寻回） */
export interface ClippedToolDetail {
    id: string;
    tool: string;
    render: ToolResultMode;
    origLines: number;
    origBytes: number;
    keptLines: number;
    keptBytes: number;
    origPath: string;
}

/**
 * 自动压缩的**触发理由**（用户 2026-10-06：自动压也要能看到"为什么压"）。
 * 全是**确定事实**，不含任何"划不划算"的预测（后者是 230#25 明确放弃的评估）。
 */
export type CompactTrigger =
    /** 用户手动点的（含 CLI） */
    | "manual"
    /** 系统上下文（system 容器）变了 → 前缀缓存必**作废**（invalidated） */
    | "systemContextChanged"
    /** 缓存**过期**（距上次请求 > 生效 TTL，见 cache-ttl.ts） */
    | "cacheExpired"
    /** 上下文窗口占用超上限（撞墙即压） */
    | "contextWindowOver";

/**
 * 压缩账（**v2：按语义分组**，用户 2026-10-06 定；D5 命名规范「结构即语义」）。
 *
 * 为什么分组：v1 把十几项平铺，读的人要自己分辨哪些是**用户输入**、哪些是**锚点**、
 * 哪些是**结果数字**、哪些是**账目**；`keptTurns/droppedTurns` 更是塞在 `boundary` 里
 * （它们是结果，不是锚点）。分组后每块回答一个问题：
 *   policy   —— 用户拧了什么
 *   boundary —— 锚在哪（**物理位置**，可回查：ops 下标 / ops 字节偏移）
 *   size     —— 前后规模与轮数（**结果数字**）
 *   cost     —— 钱与步数（可缺：无价目表时）
 *   details  —— 明细（被丢的轮、被裁的输出、摘要）
 *
 * 兼容：**读侧两种形状都收**（`normalizeCompactEvent`）—— 旧 v1 平铺账本照旧可读，
 * 无需迁移；新写的都是 v2。
 */
export interface CompactEventRecord {
    kind: "compact";
    v: 2;
    /** 压缩 id（= ts，供 measure / undo 回指） */
    id: string;
    ts: string;
    /** 谁触发的（"auto" 是自动压缩；理由见 trigger） */
    by: "ui" | "cli" | "auto";
    /** 为什么压（手动/系统上下文变/缓存过期/窗口超限） */
    trigger: CompactTrigger;
    /** 用户拧的旋钮 */
    policy: CompactPolicy;
    /** **锚点**：只记物理位置（逻辑 id 只是 label；锚必须锚在物理位置，见 keepFromOpIndex 头注） */
    boundary: {
        /** 保留起点轮 id（label；null = 压缩那一刻全部清零） */
        keptFromTurnId: string | null;
        /** 机械锚点：压缩那一刻的 ops 下标 —— 只保留此下标之后的 op */
        keepFromOpIndex: number;
        /** 该轮 start 在 ops.jsonl 里的字节偏移（重放跳前缀的快路径） */
        keptFromOpsOffset?: number;
    };
    /** **结果数字**（规模，按投递口径算；数字之间不许打架） */
    size: {
        before: SizeSnapshot;
        after: SizeSnapshot;
        keptTurns: number;
        droppedTurns: number;
    };
    /** **账目**（可缺：无价目表时不编数） */
    cost?: {
        rates?: RateSnapshot;
        /** 压缩前这个会话的缓存读成本占总成本的比例（「有没有税可省」） */
        taxShare?: number;
        /** 零产出步数（上下文增量为 0 的步 = 纯重发，压缩的靶子） */
        zeroOutputSteps?: number;
        /**
         * 一次性重建代价（$）= 保留部分按 (全价 − 缓存读) 重读一次 —— **纯账，不是预测**，
         * panel 的「事实」行直接显示这个数（不显示「省多少」，那是没底气的预测，见 ##230#25）。
         */
        rebuildCost?: number;
        /**
         * 回填步数**估算**（##230 的「回填速度」）：会话上下文涨回压缩前水位大约还要几步。
         * 为什么它重要：清零的收益只在「回填期」存在 —— 实测清零后 19~37 步就涨回 50k~150k，
         * 「省 20%」的原估因此缩水到 10~14%。标注为估算（无 tokenizer，按步均增量推）。
         */
        backfillSteps?: number;
    };
    /** **明细**（体积可控：只存摘要 + 指针，全文留在 ops 原地） */
    details?: {
        /** 被丢弃的轮（只存摘要 + 指针） */
        dropped?: DroppedTurnDetail[];
        /** 被裁剪的工具输出（只对保留部分生效；原文落盘可寻回） */
        clipped?: ClippedToolDetail[];
        /** 摘要（勾选 summary 且已生成） */
        summary?: {
            /** 走 summary.md 模版渲染出的文本 */
            text: string | null;
            /** 结构化数据（再生成/预览占位用；见 shared/context/summary.ts） */
            data: import("./summary").SummaryData | null;
            cost: number | null;
        };
    };
}

/** v1 平铺账（历史遗留形状；只用于**读**，`normalizeCompactEvent` 把它归一成 v2） */
interface CompactEventRecordV1 {
    kind: "compact";
    v: 1;
    id: string;
    ts: string;
    by: "ui" | "cli";
    policy: CompactPolicy;
    boundary: {
        keptFromTurnId: string | null;
        keepFromOpIndex?: number;
        keptFromOpsOffset?: number;
        keptTurns?: number;
        droppedTurns?: number;
    };
    before: SizeSnapshot;
    after: SizeSnapshot;
    rates?: RateSnapshot;
    taxShare?: number;
    zeroOutputSteps?: number;
    rebuildCost?: number;
    backfillSteps?: number;
    droppedDetail?: DroppedTurnDetail[];
    clipped?: ClippedToolDetail[];
    summaryText?: string | null;
    summaryData?: import("./summary").SummaryData | null;
    summaryCost?: number | null;
}

/**
 * 账本一条 compact 事件 → **统一（v2 分组）形状**。
 * v1 平铺 / v2 分组都收；缺的分组给空对象/省略（不是 `{}` 空壳 —— 见 measure 的 predicted 教训）。
 * ⚠️ v1 的 `boundary.keptTurns/droppedTurns` 是**结果数字**却塞在锚点里 → 归到 `size`。
 */
function normalizeCompactEvent(e: CompactEventRecord | CompactEventRecordV1): CompactEventRecord {
    if (e.v === 2) return e;
    const v1 = e;
    const hasDetails =
        v1.droppedDetail !== undefined ||
        v1.clipped !== undefined ||
        v1.summaryText !== undefined ||
        v1.summaryData !== undefined ||
        v1.summaryCost !== undefined;
    const hasCost =
        v1.rates !== undefined ||
        v1.taxShare !== undefined ||
        v1.zeroOutputSteps !== undefined ||
        v1.rebuildCost !== undefined ||
        v1.backfillSteps !== undefined;
    return {
        kind: "compact",
        v: 2,
        id: v1.id,
        ts: v1.ts,
        by: v1.by,
        // v1 没有 trigger 概念：旧账一律视为手动
        trigger: "manual",
        policy: v1.policy,
        boundary: {
            keptFromTurnId: v1.boundary.keptFromTurnId,
            keepFromOpIndex: v1.boundary.keepFromOpIndex ?? -1,
            ...(v1.boundary.keptFromOpsOffset !== undefined
                ? { keptFromOpsOffset: v1.boundary.keptFromOpsOffset }
                : {}),
        },
        size: {
            before: v1.before,
            after: v1.after,
            keptTurns: v1.boundary.keptTurns ?? v1.after.turns,
            droppedTurns: v1.boundary.droppedTurns ?? v1.before.turns - v1.after.turns,
        },
        ...(hasCost
            ? {
                  cost: {
                      ...(v1.rates !== undefined ? { rates: v1.rates } : {}),
                      ...(v1.taxShare !== undefined ? { taxShare: v1.taxShare } : {}),
                      ...(v1.zeroOutputSteps !== undefined ? { zeroOutputSteps: v1.zeroOutputSteps } : {}),
                      ...(v1.rebuildCost !== undefined ? { rebuildCost: v1.rebuildCost } : {}),
                      ...(v1.backfillSteps !== undefined ? { backfillSteps: v1.backfillSteps } : {}),
                  },
              }
            : {}),
        ...(hasDetails
            ? {
                  details: {
                      ...(v1.droppedDetail !== undefined ? { dropped: v1.droppedDetail } : {}),
                      ...(v1.clipped !== undefined ? { clipped: v1.clipped } : {}),
                      ...(v1.summaryText !== undefined || v1.summaryData !== undefined || v1.summaryCost !== undefined
                          ? {
                                summary: {
                                    text: v1.summaryText ?? null,
                                    data: v1.summaryData ?? null,
                                    cost: v1.summaryCost ?? null,
                                },
                            }
                          : {}),
                  },
              }
            : {}),
    };
}

/**
 * 压缩后首次真发的实测（异步补写）。
 *
 * 为什么现在就要存：用户明确**放弃了压缩效果评估**（##230#25「数据上如何算好算坏，我还没底气」），
 * 但「不评估」不等于「不存数据」—— 这六项（税率 / 回填步数 / 零产出步 / k / 重建代价 / 预测 vs 实测）
 * 是将来想算账时**唯一无法回补**的东西：请求发出去就没了。预测值也一并存，
 * 因为 ##230 的教训正是「朴素估算高估 30~45%」，两个数并排存才能验证修正模型准不准。
 */
export interface MeasureEventRecord {
    kind: "measure";
    v: 1;
    ref: string;
    ts: string;
    firstTurnId: string;
    /** ⚠️ 只有**真有预测值**时才写：空壳 `{}` 落盘毫无信息量（实测账本里就有）。 */
    predicted?: { estTokens?: number };
    actual?: {
        windowTotal?: number;
        inputTotal?: number;
        cacheRead?: number;
        noCache?: number;
        cost?: number | null;
        cacheHitRate?: number | null;
    };
}

export interface UndoEventRecord {
    kind: "undo";
    v: 1;
    ref: string;
    ts: string;
}

export type CompactLogEvent = CompactEventRecord | MeasureEventRecord | UndoEventRecord;

/** 从 jsonl 文本解析账本（坏行跳过 —— 账本坏了不该连带整个会话不可用） */
export function parseCompactLog(text: string): CompactLogEvent[] {
    const out: CompactLogEvent[] = [];
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        try {
            const e = JSON.parse(line) as CompactLogEvent | CompactEventRecordV1;
            if (!e || typeof e !== "object" || typeof (e as { kind?: unknown }).kind !== "string") continue;
            // 读侧归一：v1 平铺账 → v2 分组（旧账本无需迁移，下游只见一种形状）
            out.push(e.kind === "compact" ? normalizeCompactEvent(e) : (e as CompactLogEvent));
        } catch {
            // 崩溃半行跳过（与 local-agent 的 readJsonl 同策略）
        }
    }
    return out;
}

/** 当前生效的边界（= 最后一条未被 undo 的 compact） */
export interface EffectiveBoundary {
    compactId: string;
    keptFromTurnId: string | null;
    /** 机械锚点（op 下标）；-1 = 老账本没记（下游按 keptFromTurnId 回退推导） */
    keepFromOpIndex: number;
    keptFromOpsOffset?: number;
    policy: CompactPolicy;
    ts: string;
}

/**
 * 由账本推出**当前生效**的压缩。
 * undo 语义：只撤销它点名的那一次（其余保留）—— 于是「撤销最后一次」自然回落到上一次的边界，
 * 而撤销中间某次不会把后面的也抹掉（append-only，不删行，可审计）。
 */
export function resolveBoundary(events: readonly CompactLogEvent[]): EffectiveBoundary | null {
    const alive = new Map<string, CompactEventRecord>();
    const order: string[] = [];
    for (const e of events) {
        if (e.kind === "compact") {
            if (!alive.has(e.id)) order.push(e.id);
            alive.set(e.id, e);
        } else if (e.kind === "undo") {
            alive.delete(e.ref);
        }
    }
    const last = [...order].reverse().find((id) => alive.has(id));
    if (!last) return null;
    const c = alive.get(last)!;
    return {
        compactId: c.id,
        keptFromTurnId: c.boundary.keptFromTurnId,
        keepFromOpIndex: c.boundary.keepFromOpIndex ?? -1,
        ...(c.boundary.keptFromOpsOffset !== undefined
            ? { keptFromOpsOffset: c.boundary.keptFromOpsOffset }
            : {}),
        // 读侧归一：旧账本存的是扁平 policy（keepTurns/toolResult/headtail），
        // 这里统一成三轴 —— 于是「历史账本」与「新写的账本」下游完全同形（初版紧凑、扩展松散）。
        policy: normalizePolicy(c.policy),
        ts: c.ts,
    };
}

// ─── ④ ops 切片（结构类型，避免 shared 依赖 main 的 local-blocks）────

/** 只用到 op 流的最小结构（真身是 local-blocks 的 Op） */
export interface OpLike {
    op: string;
    id: string;
    kind?: string;
}

/** 一轮 turn 的 start 在 op 流里的下标（找不到返回 -1） */
export function indexOfTurn(ops: readonly OpLike[], turnId: string): number {
    for (let i = 0; i < ops.length; i++) {
        const o = ops[i]!;
        if (o.op === "start" && o.kind === "turn" && o.id === turnId) return i;
    }
    return -1;
}

/**
 * 从某个 turn 起切片（用于「当前会话」与「历史某代」的 ops 视图）。
 *   · sinceTurnId = null  → 空数组（全部清零：新会话从零开始）
 *   · 找不到该 turn（日志被截/换机器）→ **返回全量**：宁可多给，不可让用户面对空白会话
 */
export function sliceOpsFromTurn<T extends OpLike>(ops: readonly T[], sinceTurnId: string | null | undefined): T[] {
    if (sinceTurnId == null) return [];
    const i = indexOfTurn(ops, sinceTurnId);
    return i < 0 ? [...ops] : ops.slice(i);
}

/**
 * 从 op 下标 idx 起，第一个 turn 的 id；无（idx 已越界）→ null（= 投递"空历史"）。
 * 与 keepFromOpIndex 配套：它把"机械锚点"翻译成 blocksToMessages 用的 turn 边界。
 */
export function turnIdAtOrAfterOp(ops: readonly OpLike[], idx: number): string | null {
    for (let i = Math.max(0, idx); i < ops.length; i++) {
        const o = ops[i]!;
        if (o.op === "start" && o.kind === "turn") return o.id;
    }
    return null;
}

/** 会话里所有 turn 的 id（按出现顺序） */
export function listTurnIds(ops: readonly OpLike[]): string[] {
    const out: string[] = [];
    for (const o of ops) if (o.op === "start" && o.kind === "turn") out.push(o.id);
    return out;
}

/** turn id（`t<epochMs>`）→ 时刻；非法格式返回 null（不猜） */
export function turnIdToTime(turnId: string): Date | null {
    const m = /^t(\d{10,})$/.exec(turnId);
    if (!m) return null;
    const d = new Date(Number(m[1]));
    return Number.isFinite(d.getTime()) ? d : null;
}

// ─── ⑤ 历史代（历史会话列表的数据源）────────────────────

export interface GenerationInfo {
    /** 第几代（0 = 最初那一代） */
    seq: number;
    /** 这一代的起点轮（null = 从会话最开始；第 0 代必为 null） */
    fromTurnId: string | null;
    /** 这一代截止到哪一轮（不含；null = 到当前末尾） */
    untilTurnId: string | null;
    /** 这一代什么时候开始的（第 0 代取首轮 turn id 的时刻；后续取压缩时刻） */
    startedAt: string | null;
    /** 是不是当前生效的这一代 */
    current: boolean;
    /** 被这次压缩压掉的次数（第 0 代后面紧跟的压缩 id） */
    compactId: string | null;
    policy?: CompactPolicy;
    /** 谁压的（ui / cli / auto）—— 历史列表要能看出"这代是自动压的还是我压的" */
    by?: "ui" | "cli" | "auto";
    /** 为什么压（用户 2026-10-06：自动压也要能看到压缩历史与理由） */
    trigger?: CompactTrigger;
    /** 压缩时刻（与 startedAt 同源，但**第 0 代没有** —— 它不是被压出来的） */
    compactTs?: string;
}

/**
 * 由「turn 顺序 + 生效的压缩链」列出各代。
 *
 * 定义：每次压缩把会话切成两代 —— 被丢的那段结尾、以及从边界起的新一段。
 * 于是**第 k 代的终点 = 第 k+1 代的起点**；最后一代的终点为 null（= 至今）。
 * 点「撤销」后这条链少一环，两代自然合并回一代（无需迁移任何数据）。
 */
export function listGenerations(
    turnIds: readonly string[],
    events: readonly CompactLogEvent[],
): GenerationInfo[] {
    // 生效链（保留顺序、跳过被 undo 的）
    const alive = new Map<string, CompactEventRecord>();
    const order: string[] = [];
    for (const e of events) {
        if (e.kind === "compact") {
            if (!alive.has(e.id)) order.push(e.id);
            alive.set(e.id, e);
        } else if (e.kind === "undo") alive.delete(e.ref);
    }
    const chain = order.filter((id) => alive.has(id)).map((id) => alive.get(id)!);
    const valid = chain.filter((c) => c.boundary.keptFromTurnId === null || turnIds.includes(c.boundary.keptFromTurnId));

    const gens: GenerationInfo[] = [];
    const firstTurn = turnIds[0] ?? null;
    gens.push({
        seq: 0,
        fromTurnId: null,
        untilTurnId: valid[0]?.boundary.keptFromTurnId ?? null,
        startedAt: firstTurn ? (turnIdToTime(firstTurn)?.toISOString() ?? null) : null,
        current: valid.length === 0,
        compactId: valid[0]?.id ?? null,
    });
    valid.forEach((c, i) => {
        gens.push({
            seq: i + 1,
            fromTurnId: c.boundary.keptFromTurnId,
            untilTurnId: valid[i + 1]?.boundary.keptFromTurnId ?? null,
            startedAt: c.ts,
            current: i === valid.length - 1,
            compactId: c.id,
            policy: c.policy,
            by: c.by,
            trigger: c.trigger,
            compactTs: c.ts,
        });
    });
    return gens;
}

/** 某代覆盖的 turn id 列表（用于算这一代的消息数/字节 —— 历史列表的三列） */
export function turnsOfGeneration(turnIds: readonly string[], gen: GenerationInfo): string[] {
    const start = gen.fromTurnId === null ? 0 : turnIds.indexOf(gen.fromTurnId);
    const from = start < 0 ? 0 : start;
    const end = gen.untilTurnId === null ? turnIds.length : turnIds.indexOf(gen.untilTurnId);
    return turnIds.slice(from, end < 0 ? turnIds.length : end);
}

/** 粗略 token 估算：字节/4（无 tokenizer；只用于 panel 的「首屏估算」文案，绝不用于计费） */
export function estimateTokens(bytes: number): number {
    return Math.round(bytes / 4);
}
