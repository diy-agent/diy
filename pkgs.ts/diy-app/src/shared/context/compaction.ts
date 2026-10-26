// src/shared/context/compaction.ts
// 🎯 「压缩会话上下文」—— 策略 / 工具输出裁剪 / 事件账本 / 边界求值（纯函数，禁止 import node:*）
//
// 为什么单独一个文件、且必须是纯模块：
//   · main 要用它决定「投递哪些块」（blocksToMessages 的裁剪闭包）；
//   · renderer 要用它做**预览页**（当前会话 vs 压缩后 diff）与压缩历史（事件快照列表）—— 预览不能靠 RPC
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
import { cutMarker } from "../cut-marker";

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
 * 默认头尾裁剪参数：**保留前 80 行 + 后 20 行，超过 100 行才裁**，单条总量兜底 100KB。
 *
 * 旧值（前 3 / 后 3 / 6 行即裁 / 8KB / 单行 300 字符）来自 ##230 的「省上下文」取向。
 * ##402 实测推翻了那个取向：**裁得越碎，模型越要多次分片读**，而每次分片读都是一次完整请求
 * （实测平均 294KB 请求体）—— 省下的几千字节远小于多跑一轮的代价。故改为「尽量给全」：
 *   · 触发阈值 100 行（p90=64 行的绝大部分输出**原样**给，不再一律砍成 6 行）；
 *   · 单行 2000 字符（与 services/tool-output.ts 的 maxLineChars 同口径；300 会把 jsonl /
 *     压缩 JS 这类「一行一条记录」的文件砍成半条，且不可续读）；
 *   · 单条 100KB 兜底（防「一行超长」钻空子，不是常规闸）。
 * 真正的总量闸是 `history.limit.limitTokens`（用户配置），此处只管**一条**能有多大。
 */
export const DEFAULT_HEADTAIL: HeadTailPolicy = {
    triggerLines: 100,
    headLines: 80,
    tailLines: 20,
    maxLineChars: 2000,
    maxKeepBytes: 100 * 1024,
};

// ─── 策略：带**归属**的结构（用户 2026-10-06 定稿）───────────────────
//
// 现役**只有 budget 一种算法**（`reset` / `keep` 已在 ##271 删除，未发布无需兼容）。
// 结构约定：与 `mode` 同级 = 所有算法共有（`summary`）；`modeData` 内 = 该 mode **私有**
// （换 mode 就换一整包）—— 私有参数收进分支，读结构即知归属（D5「结构即语义」）。

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
        // 私有参数收进 renderData —— 与 modeData 同一原则：**归属在结构里**，不靠注释
        renderData: z
            .object({
                head: z.number().describe("保留头部行数"),
                tail: z.number().describe("保留尾部行数"),
                maxLineChars: z.number().describe("单行超长截断阈值（字符）"),
                maxKeepBytes: z.number().describe("保留总量兜底（字节），防「一行超长」钻空子"),
            })
            .describe("headtail 私有参数（只此支有）"),
    }),
    z.object({ render: z.literal("callpath").describe("只留调用 + 原文路径") }),
]);

/** 「是否额外算一份历史摘要」——与 `mode` 同级（所有算法共有），不进 `modeData` */
const SummaryField = z.boolean().describe("是否额外算一份历史摘要（暂未启用；预留字段）");

/** 策略真源：**只有 budget 一种算法**（`reset` / `keep` 已删除 —— 用户 2026-10-07，未发布无需兼容）。
 *
 * 结构约定：与 `mode` 同级 = 所有算法共有（`summary`）；`modeData` 内 = 该 mode **私有**
 * （换 mode 就换一整包）。命名用 `<判别键>Data`（非 `data`）以避多判别键撞车。
 */
export const CompactPolicySchema = z.object({
    mode: z
        .literal("budget")
        .describe("⚠️ 已废弃（不决定投递）：保留只是为了旧配置与旧调用点仍能解析。投递选择只看 `history.limit`"),
    // ##432 清理（用户 2026-10-25）：`modeData.budgetBytes` **整体删除** —— 名字本身也不留。
    // 历史上限只剩 `history.limit.limitTokens`（token）；旧配置里的 `budgetBytes` 由读侧
    // 一次性映射成 token 上限 + 出声（见 `auto-compact.ts::normalizeAutoCompact`），写回即新形状。
    modeData: z
        .object({
            toolResult: ToolResultPolicySchema.describe("工具结果在配置的呈现"),
        })
        .describe("budget 算法私有参数（只此支有）"),
    summary: SummaryField,
});
export type ToolResultPolicy = z.infer<typeof ToolResultPolicySchema>;
export type BudgetPolicy = z.infer<typeof CompactPolicySchema>;
export type CompactPolicy = z.infer<typeof CompactPolicySchema>;
export type CompactMode = CompactPolicy["mode"];


/** 预算缺省的工具结果呈现（头尾裁剪：长输出留头尾、中间省略，原文可回取） */
export const DEFAULT_TOOL_RESULT_POLICY: ToolResultPolicy = {
    render: "headtail",
    renderData: {
        head: DEFAULT_HEADTAIL.headLines,
        tail: DEFAULT_HEADTAIL.tailLines,
        maxLineChars: DEFAULT_HEADTAIL.maxLineChars,
        maxKeepBytes: DEFAULT_HEADTAIL.maxKeepBytes,
    },
};

/** 策略真源（UI/CLI 的缺省）：工具结果头尾裁剪 + 不算摘要 */
export const DEFAULT_COMPACT_POLICY: BudgetPolicy = {
    mode: "budget",
    modeData: { toolResult: DEFAULT_TOOL_RESULT_POLICY },
    summary: false,
};

// ── 下游只认这两个收口函数（不再有内容轴 / 模式判别）──

/** 工具结果的呈现策略（预算策略唯一来源 = `modeData.toolResult`） */
export function toolResultOf(p: CompactPolicy): ToolResultPolicy {
    return p.modeData.toolResult;
}

// ── 裁剪能力轴（clip）──
//
// 「这条工具结果**怎么裁**」原先只有**全局一档**（`toolResult.render`）；##343 M1 起升为
// **可按级声明**：每条取法（picker / stage）各自带 `clip`，**先声明者赢**，缺省回落
// `history.defaultClip`（= 旧全局策略的降级 ⇒ 不声明即老行为）。
// 形状遵 `rule.discriminated-union`：判别键 `type` 同级 = 所有分支共有；分支私有参数进 `data`。
/** headtail 的私有参数（触发阈值 = head + tail，见 HeadTailPolicy） */
export const HeadTailParamsSchema = z.object({
    head: z.number().int().nonnegative().describe("保留头部行数"),
    tail: z.number().int().nonnegative().describe("保留尾部行数"),
    maxLineChars: z.number().int().positive().describe("单行超长截断阈值（字符）"),
    maxKeepBytes: z.number().int().positive().describe("保留总量字节兜底"),
});
export type HeadTailParams = z.infer<typeof HeadTailParamsSchema>;

/**
 * clip 的**真源 schema**（zod）—— 因为 clip 要**从配置读进来**（`history.keep[].clip`，##344 M2），
 * 校验必须在写盘前发生（非法 clip 形状 → 拒绝写、给理由）。类型由 schema 推出，杜绝两处漂移。
 */
export const ClipSpecSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("full").describe("不裁（保底最近 N 步要的就是字节保真：headtail 一动，「留下的结果被裁成头尾」就治不了）"),
    }),
    z.object({ type: z.literal("path").describe("只留调用 + 原文路径") }),
    z.object({
        type: z.literal("headtail").describe("头尾保留 + 中间 marker（私有参数进 data）"),
        data: HeadTailParamsSchema.describe("headtail 私有参数（只此支有）"),
    }),
]);
export type ClipSpec = z.infer<typeof ClipSpecSchema>;

/** 全局策略（旧形状）→ clip 缺省值（**降级**：M1 之前只有这一档） */
export function clipSpecOf(tr: ToolResultPolicy): ClipSpec {
    if (tr.render === "asis") return { type: "full" };
    if (tr.render === "callpath") return { type: "path" };
    return { type: "headtail", data: { ...tr.renderData } };
}

/**
 * clip → `clipToolResult` 吃的策略（**唯一换算点**）。
 * 选择阶段算成本、渲染阶段真裁，两段必须走同一份换算 —— 否则「预算按 A 算、发出去是 B」。
 */
export function toToolResultPolicy(clip: ClipSpec): ToolResultPolicy {
    if (clip.type === "full") return { render: "asis" };
    if (clip.type === "path") return { render: "callpath" };
    return { render: "headtail", renderData: { ...clip.data } };
}

// ── 推理文本裁剪（reasoning clip · ##374 T2）──
//
// 为什么另开一档、而不是复用 `ClipSpec`：`ClipSpec` 的语义与参数面是为**工具结果**定的 ——
//   · `path`（只留调用 + 原文路径）对推理没有意义（推理没有"原文文件"）；
//   · `headtail` 的参数是**行**（head/tail 行数），而推理是**散文**（常常一整段一行）——
//     按行裁会在「一行 3000 字」时等于全留、在「30 行短句」时裁掉大半，两头都错。
// 所以 reasoning 这一轴按**字符**裁，且参数面单独一支（遵 `rule.discriminated-union`）。
//
// ⚠️ **硬约束（##374 T1 实测）**：上游在 luminal 端点是**逐条校验** —— 任何一条带 `tool_calls`
// 的 assistant 缺 `reasoning_content` 就整轮 400（`The reasoning_content in the thinking mode
// must be passed back to the API.`）。⇒ 推理**只可裁短、不可裁空、更不可删 part**。
// 于是 `headChars` 必须 ≥ 1（schema 层就拦住 0），且 `clipReasoningText` 对非空输入**永不返回空串**。

/** headtail（推理）的私有参数：按**字符**保头（+可选尾） */
export const ReasoningHeadTailParamsSchema = z.object({
    headChars: z.number().int().positive().describe("保留头部字符数（≥1 —— 裁到空 = 等于没传 = 上游 400）"),
    tailChars: z.number().int().nonnegative().describe("保留尾部字符数（0 = 只保头）"),
});
export type ReasoningHeadTailParams = z.infer<typeof ReasoningHeadTailParamsSchema>;

/**
 * 推理裁剪的真源 schema（zod）—— 与 `ClipSpecSchema` 同构：判别键 `type` 同级 = 公共字段，
 * 分支私有参数进 `data`。它要**从配置读进来**（`history.keep[].reasoningClip`）⇒ 写盘前必须校验。
 */
export const ReasoningClipSpecSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("full").describe("不裁（保底级要的是推理字节保真）") }),
    z.object({
        type: z.literal("headtail").describe("保头（+可选尾）+ 中间 marker；按**字符**（推理是散文，不按行）"),
        data: ReasoningHeadTailParamsSchema.describe("headtail 私有参数（只此支有）"),
    }),
]);
export type ReasoningClipSpec = z.infer<typeof ReasoningClipSpecSchema>;

/**
 * 推理的**保守缺省裁法**（##374 T2；`##432` 清理后这是唯一来源 —— 级列表已删，不再有"哪一级声明"）。
 *
 * 为什么是保头 600 字符（实测依据，样本 = 4 条真实长会话 `~/.diy/local/*.llm.jsonl`，
 * 2163 条推理 part / 3.35 MiB）：字符数 p50=571 · p75=1362 · p90=2962。
 * 保头 600 ⇒ 推理总字节降到 36.9%（裁掉 1051/2163 条的尾巴）；保头 300 ⇒ 23.0%。
 * 取 600 = **保守**（保住约一段话的开头，含模型的判断依据）。
 */
export const DEFAULT_REASONING_CLIP = {
    type: "headtail",
    data: { headChars: 600, tailChars: 0 },
} as const;

/** 一条推理文本的裁剪账（供统计 / marker / 测试断言） */
export interface ReasoningClipResult {
    text: string;
    clipped: boolean;
    origChars: number;
    keptChars: number;
    droppedChars: number;
}

/**
 * 推理文本裁剪（**纯函数**，与 `clipToolResult` 同一条原则）：
 *   · 不触发阈值时**逐字符返回原文**（不"顺手规整"）；
 *   · 触发时 = 头 `headChars` + marker + 尾 `tailChars`；
 *   · **结果永不为空**（非空输入 ⇒ 非空输出）：head 至少 1 字符 + marker，兜住 ##374 T1 的 400。
 */
export function clipReasoningText(text: string, clip: ReasoningClipSpec | null | undefined): ReasoningClipResult {
    const origChars = text.length;
    const same = (): ReasoningClipResult => ({
        text,
        clipped: false,
        origChars,
        keptChars: origChars,
        droppedChars: 0,
    });
    if (!clip || clip.type === "full" || text === "") return same();

    const headN = Math.min(clip.data.headChars, origChars);
    const tailN = Math.min(clip.data.tailChars, Math.max(0, origChars - headN));
    const dropped = origChars - headN - tailN;
    if (dropped <= 0) return same(); // 本来就短 ⇒ 不动（也保证"极短也不裁空"）

    // ##425：wire 档（发给模型的那份就是残缺的；推理原文不在任何地方可回取）
    const marker = `\n${cutMarker({ by: "reasoning-clip", scope: "wire", why: "budget", unit: "chars", total: origChars, kept: headN + tailN })}\n`;
    // head 至少留 1 字符（headChars ≥ 1 由 schema 保证）：空串 = 没传 = 400，这条断言是硬底线
    const out = `${text.slice(0, Math.max(1, headN))}${marker}${tailN > 0 ? text.slice(origChars - tailN) : ""}`;
    return { text: out, clipped: true, origChars, keptChars: out.length, droppedChars: dropped };
}

/**
 * 扁平（**输入面**）形状：RPC / CLI / UI state 用的紧凑契约（`flatPolicyOf` 是树 → 扁平），**不是**真源形状。
 *
 * 为什么输入面可以继续扁平：UI 自己保证「只产生合法组合」（按分支展开），CLI 的
 * `--budget-bytes / --tool-result / …` 是给人用的快捷语法；而**真源**（账本 / auto-compact.yaml）
 * 必须是带归属的结构 —— 那里要给人读、要自解释。
 * `normalizePolicy` 是唯一适配点（扁平/旧形状 → 树），`flatPolicyOf` 是反向（树 → 扁平，供 UI 回读）。
 */
export interface FlatCompactPolicy {
    toolResult: ToolResultMode;
    headtail: HeadTailPolicy;
    summary: boolean;
}

/** 策略 → 扁平 */
export function flatPolicyOf(p: CompactPolicy): FlatCompactPolicy {
    const tr = p.modeData.toolResult;
    const d = tr.render === "headtail" ? tr.renderData : null;
    const ht = d
        ? { triggerLines: d.head + d.tail, headLines: d.head, tailLines: d.tail, maxLineChars: d.maxLineChars, maxKeepBytes: d.maxKeepBytes }
        : { ...DEFAULT_HEADTAIL };
    return { toolResult: tr.render, headtail: ht, summary: p.summary };
}

const posNum = (v: unknown, d: number, min = 0): number =>
    typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : d;

/** 工具结果策略的宽松读（`{render:"headtail", renderData:{…}}` 或扁平 `{render:"headtail", head,…}`） */
function readToolResult(raw: unknown, ht: Partial<HeadTailPolicy>): ToolResultPolicy {
    const htOf = (o: Record<string, unknown>): ToolResultPolicy => {
        const rd = (o["renderData"] ?? o) as Record<string, unknown>;
        return {
            render: "headtail",
            renderData: {
                head: posNum(rd["head"], ht.headLines ?? DEFAULT_HEADTAIL.headLines, 0),
                tail: posNum(rd["tail"], ht.tailLines ?? DEFAULT_HEADTAIL.tailLines, 0),
                maxLineChars: posNum(rd["maxLineChars"], ht.maxLineChars ?? DEFAULT_HEADTAIL.maxLineChars, 1),
                maxKeepBytes: posNum(rd["maxKeepBytes"], ht.maxKeepBytes ?? DEFAULT_HEADTAIL.maxKeepBytes, 1),
            },
        };
    };
    if (raw !== null && typeof raw === "object") {
        const o = raw as Record<string, unknown>;
        const m = o["render"] ?? o["mode"];
        if (m === "headtail") return htOf(o);
        return m === "callpath" ? { render: "callpath" } : { render: "asis" };
    }
    if (raw === "headtail") return htOf({});
    if (raw === "callpath") return { render: "callpath" };
    return { render: "asis" };
}

/** 宽松归一：任意输入（真源 `{mode,modeData}` 或扁平 `{toolResult,…}`）→ 合法策略（旧 `budgetBytes` 忽略） */
export function normalizePolicy(p: unknown): CompactPolicy {
    const src = (p ?? {}) as Record<string, unknown>;
    const md = (src["modeData"] ?? src) as Record<string, unknown>;
    const ht = (src["headtail"] ?? {}) as Partial<HeadTailPolicy>;
    const trRaw = md["toolResult"] ?? src["toolResult"];
    return {
        mode: "budget",
        modeData: {
            toolResult: trRaw !== undefined || ht.headLines !== undefined ? readToolResult(trRaw, ht) : DEFAULT_TOOL_RESULT_POLICY,
        },
        summary: src["summary"] === true,
    };
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
 * **单条工具结果的不可绕过硬顶**（##406 刀 3，用户 2026-10-21 口径「单条工具结果封顶前置…必须有」）。
 *
 * 为什么需要它 —— 这道顶**不是**锦上添花，是 ##401 死锁的直接成因：
 *   ① 投递层（`main/services/tool-output.ts` 的 `toModelOutput`）对**首次出洞**的单条输出有 50 KB 预算；
 *   ② 但**历史重放**走的是本函数，`clip` 由**级声明**决定 —— 缺省 plan 的第一级是
 *      旧装配管道里那条「最近若干步字节保真」的级（已于 ##432 删除），语义是「工作集逐字保真」；
 *   ③ `full` 直接原样返回 ⇒ **① 的封顶被绕过**，几步之内累积出 4.95 MB 发了出去
 *      （实测 `~/.diy/log/network/2026-10-21.jsonl`：16:34 一次 282 KB，16:57 直接跳到 4,946,910 B）。
 *  ⇒ 结论：**「full」只能是「不额外裁」，不能是「无上限」**。上限由这道硬顶兜住，任何级声明都翻不过去。
 *
 * 为什么是 100 KB：单条正常的工具输出上限本来就是 `read` 的窗口（`READ_MAX_BYTES` = 50 KB），
 * 硬顶给到 2 倍余量，既不误伤正常阅读，也把「MB 级单条」关在门外。
 * `callpath`（只留调用）本身就是最小形态，不受影响。
 */
export const HARD_MAX_TOOL_RESULT_BYTES = 100 * 1024;

/** 触及硬顶时强制使用的裁剪参数（头 2000 行 / 尾 2000 行 / 单行 4000 字符 / 总 100 KB） */
const HARD_CAP_POLICY: ToolResultPolicy = {
    render: "headtail",
    renderData: { head: 2000, tail: 2000, maxLineChars: 4000, maxKeepBytes: HARD_MAX_TOOL_RESULT_BYTES },
};

/**
 * 按策略裁一段工具输出。
 *
 * 设计要点：
 *   · **未触发裁条件时逐字符返回原文** —— 不"顺手规整"，否则 86% 不受影响的输出会和历史分叉；
 *   · 行数触发是主判据（阈值 ≈ p90），字节兜底只防"一行超长"（压缩 JSON / base64）；
 *   · marker 里**必须**给原文路径（##127 的「头尾保留 + marker + 原文可寻回」三件套），
 *     否则模型看到「被截了」却无处可查，只能重跑一遍命令（那是真金白银）。
 *     语法统一走 `shared/cut-marker`（##425）：`<cut by=… scope="wire" … resume="<path>"/>`。
 */
export function clipToolResult(text: string, raw: ToolResultPolicy, opts: ClipOpts = {}): ToolClipResult {
    const origLines = text === "" ? 0 : text.split("\n").length;
    const origBytes = utf8Bytes(text);
    // 硬顶（##406）：**先于**任何级声明生效 —— `full` / `asis` 都翻不过去。
    // 不递归：把策略就地换成硬顶 headtail，继续走下面同一条路径。
    const toolResult: ToolResultPolicy =
        origBytes > HARD_MAX_TOOL_RESULT_BYTES && raw.render !== "callpath" ? HARD_CAP_POLICY : raw;
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
    // ##425：wire 档 —— 发给模型的那份被裁；原文落盘时给 `resume`（模型可 `read` 回取），
    // 没落盘就不给（指向一个不存在的文件比不说还坏）。
    const resume = opts.origPath;

    if (toolResult.render === "callpath") {
        if (text === "") return same();
        const marker = cutMarker({
            by: "tool-result-callpath",
            scope: "wire",
            why: "budget",
            total: origLines,
            kept: 0,
            ...(resume ? { resume } : {}),
        });
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
    const rd = toolResult.renderData;
    const ht = { triggerLines: rd.head + rd.tail, headLines: rd.head, tailLines: rd.tail, maxLineChars: rd.maxLineChars, maxKeepBytes: rd.maxKeepBytes };
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
        // ##425：wire 档。`total` / `kept` 都按**行**（与 `unit` 同量纲）；
        // 行内超长被 `maxLineChars` 再截的部分不另报 —— marker 只回答「中间少了多少行」。
        const marker = cutMarker({
            by: "tool-output",
            scope: "wire",
            why: "budget",
            total: origLines,
            kept: headN + tailN,
            ...(resume ? { resume } : {}),
        });
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
    /**
     * **全局回落 clip**（= 策略 `toolResult.render` 的降级）：没被任何级声明 clip 的消息用它。
     * 有它才谈得上「保底级声明 `full`、其余照旧裁」—— 回落值必须随策略走，不能各自写死。
     */
    defaultClip: ClipSpec;
    /**
     * 工具结果渲染。入参带 `clip`（**这条消息**的裁法；缺省 = 回落 `defaultClip`）：
     * 选择阶段与渲染阶段共用同一个渲染器，clip 由选择结果带出（见 local-blocks 的两段分离）。
     */
    transformToolResult?: (b: { id: string; tool: string; output: string; clip?: ClipSpec | null }) => string;
}

/** 由策略构造投递选项（真发与预览共用；预览在 renderer 现算，真发在 main 算） */
export function makeDeliveryTransform(
    policy: CompactPolicy,
    origPathOf: (id: string) => string,
    collect?: ClippedToolDetail[],
): DeliveryTransform {
    const tr = toolResultOf(policy);
    const opts: DeliveryTransform = { defaultClip: clipSpecOf(tr) };
    // 一律装上渲染器（不再按 `tr.render !== "asis"` 早退）：全局策略是 `asis` 时它是**恒等变换**
    // （`clipToolResult` 直接原样返回），但**级声明的 clip 仍要生效** —— 否则「全局 asis + 保底 full」
    // 这类组合会被全局策略掐死（级声明比全局更具体，谁更具体听谁的）。
    // 去重：同一 transform 会在**多次渲染**里对同一工具结果重复调用（投递渲染 + 选择时的成本
    // 估算各一次；见 sizeOfOps 的 blocksToMessages + selectForDelivery）——同一 id 的裁剪结果
    // 确定，重复记会让 `details.clipped` 虚胖（实测每个 id 恰 2×）。按 id 只记一次。
    const seen = new Set<string>();
    opts.transformToolResult = ({ id, output, clip }) => {
        // 缺省回落：该消息没被任何级声明 clip ⇒ 用全局策略（老行为逐字不变）
        const eff = clip ?? opts.defaultClip;
        const r = clipToolResult(output, toToolResultPolicy(eff), { origPath: origPathOf(id) });
        if (!r.clipped) return output;
        if (seen.has(id)) return r.text;
        seen.add(id);
        collect?.push({
            id,
            tool: "",
            render: eff.type === "path" ? "callpath" : "headtail",
            origLines: r.origLines,
            origBytes: r.origBytes,
            keptLines: r.keptLines,
            keptBytes: r.keptBytes,
            origPath: origPathOf(id),
        });
        return r.text;
    };
    return opts;
}

// ─── ③ 事件账本 ────────────────────────────────────────

/** 规模快照（前后对比 / 压缩事件快照共用） */
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
    /**
     * 保留起点**在全量消息日志（llm.jsonl）里的行号**（1-based；= `projectAll` 下标 + 1）。
     *
     * 为什么必须记（##420）：读取侧只 replay `keptFromOpsOffset` 之后的 op ⇒ 块树里只剩保留段，
     * 于是「下标 = llm.jsonl 行号」这条对齐**整体错位**了被跳过的消息条数。用 `keptFromOpsOffset`
     * 只能跳字节，说不出「跳过了几条消息」—— 而投递注记（`history.kept` 行号）与 llm.jsonl 的
     * append 对账都按行号对齐。记下它，跳过的部分才是**可换算**的（`lineBase = 行号 - 1`）。
     * 缺省（旧账）= 不换算，读取侧退回全量重放（安全优先）。
     */
    keptFromLlmLine?: number;
    /**
     * 压缩那一刻 ops.jsonl 的**完整行字节数**（起点自证，##420）。
     *
     * `keptFromOpsOffset` 只在 append-only 前提下有效：文件被截断 / 换了一份（清空、搬机器、覆盖写），
     * 同一个偏移就指到别的 op 上。加载时比 `statSync(fp).size < opsBytes` 即可判「起点作废」——
     * 作废必须走**断代**（起点 = EOF），**不许**从 0 读（旧内容可能已不是同一份会话，比空更糟）。
     */
    opsBytes?: number;
    keptTurns: number;
    droppedTurns: number;
}

/**
 * 当前 ops 账本的**格式代号**（##420 的断代轴）。
 *
 * 用户 2026-10-23 的口径：「一旦升级版本号，就可以压缩一次，全当以前的格式不再遵守」。
 * 于是升级 = 一次压缩 + 旧段退化为纯审计日志（永不再 replay），跨版本兼容包袱彻底卸掉。
 * ⚠️ 读侧：**账本没写 `schema` 的旧账一律视为当前代号**（它们本来就是按这套格式写的）——
 * 把「没写」当成「不符」会让所有存量会话凭空变空会话，那不是断代，那是丢数据。
 */
export const OPS_SCHEMA_CURRENT = 1;

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

/**
 * **v5** 账本里的工具裁剪摘要（##431）：只留 id 清单 + 条数。
 *
 * 为什么不再存单项明细：`ClippedToolDetail` 六个数字 + 路径 × 每次几十项 = 单条事件 10~20 KB，
 * 而它只服务「事后看裁了什么」这种审计需求 —— 明细本来就能从 ops + 当前 policy 现算。
 * `ids` 另有硬用途：`clear()` / 落位迁移靠它找回「哪些工具原文是本会话的」。
 */
export interface ClippedIdsSummary {
    ids: string[];
    count: number;
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
 * **plan 快照**（旧字段，仅供读旧账本；##432 起新事件不再写它）。
 *
 * 为什么必须存：`policy` 只说明「旋钮拧到哪」（预算 / 全局裁法），说明不了「**为什么留这些**」——
 * 那是 `history.keep[]`（级列表）决定的。存下它，事后才能把某次压缩**回放**成「当时用的是哪套 plan」，
 * 也才能回答「换了 plan 之后，压缩后果变好还是变坏」（##340 量尺的 A/B 基线）。
 *
 * ##378 起：**不再内嵌全文**（同内容反复内嵌 = 去重 0，且没有版本链）。改为内容寻址指针
 * `planVersion` —— 旧账本里的 CAS 指针；`$DIY_HOME/plan-store/` 已随 ##432 清理删除，读旧账时只做展示。
 * v3 旧事件里的 `keep` 全文**照旧可读**（不改写既有账本；UI 要能同时显示两种）。
 */
export interface CompactPlanSnapshot {
    /** 旧账本里的历史字节上限（**旧口径**；新事件不写，读侧只用于展示"当时是什么"） */
    budgetBytes?: number;
    /** 这套 plan 从哪来：`config` = 用户/agent 配的；`default` = 配置没写、回落代码缺省管道 */
    source: "config" | "default";
    /** **v4**：内容寻址版本 id（`plan-<sha12>`）—— 旧账本的指针，回查已不可用（CAS 已删） */
    planVersion?: string;
    /** **v3 旧事件**的级列表原文（`{ type, must?, limit?, clip?, data }`）；新事件**不写**，读侧兼容 */
    keep?: unknown[];
}

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
    /**
     * v2 = 只有 `policy`（旋钮）；v3 = 多一条 `plan` 快照（##344 M2）；**v4 = plan 只记版本指针**（##378）；
     * **v5 = 明细瘦身**（##431：不再写 `details.dropped` 全文与 `details.clipped` 明细，只留计数与 id 清单）。
     * 读侧各版都收 —— 老行的大 details 照旧可读，只是新行不再产出。
     */
    v: 2 | 3 | 4 | 5;
    /** 压缩 id（= ts，供 measure / undo 回指） */
    id: string;
    ts: string;
    /**
     * 写这条账时 ops 账本的**格式代号**（`OPS_SCHEMA_CURRENT`；缺省 = 旧账，按当前代号读）。
     * 加载时 `schema !== OPS_SCHEMA_CURRENT` ⇒ **格式断代**：`keptFromOpsOffset` 不再可信，
     * 起点取 EOF（空会话），并且必须显式可见（日志 + 返回给 UI 的标记），不许静默空白。
     */
    schema?: number;
    /** 谁触发的（"auto" 是自动压缩；理由见 trigger） */
    by: "ui" | "cli" | "auto";
    /** 为什么压（手动/系统上下文变/缓存过期/窗口超限） */
    trigger: CompactTrigger;
    /** 用户拧的旋钮 */
    policy: CompactPolicy;
    /**
     * **当时整条装配管道的原文**（v3 起；v2 旧行无此字段 ⇒ 视为「缺省管道」）。
     * 只记锚点/数字说明不了「留什么、怎么裁」——那是 plan 决定的，故必须快照。
     */
    plan?: CompactPlanSnapshot;
    /** **锚点**：只记物理位置（逻辑 id 只是 label；锚必须锚在物理位置，见 keepFromOpIndex 头注） */
    boundary: {
        /** 保留起点轮 id（label；null = 压缩那一刻全部清零） */
        keptFromTurnId: string | null;
        /** 机械锚点：压缩那一刻的 ops 下标 —— 只保留此下标之后的 op */
        keepFromOpIndex: number;
        /** 该轮 start 在 ops.jsonl 里的字节偏移（重放跳前缀的快路径） */
        keptFromOpsOffset?: number;
        /** 该轮第一条消息在 llm.jsonl 里的行号（1-based；跳前缀后换算行号的依据，见 CompactBoundaryRecord） */
        keptFromLlmLine?: number;
        /** 压缩那一刻 ops.jsonl 的完整行字节数（起点自证；`size < opsBytes` ⇒ 起点作废） */
        opsBytes?: number;
    };
    /**
     * **空操作**标记（可选）：该次压缩什么都没改（无轮被丢、无工具被裁、投递字节不变）。
     * 只读检测用 —— 真正的空操作**不写账**（见 compact()），此字段供调用方判断"这次白压了"。
     */
    noop?: boolean;
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
    /** **明细**（体积可控：只存摘要 + 指针，全文留在 ops 原地）
     *
     * ⚠️ ##431 起新事件（v5）**不再写** `dropped` / `clipped` 明细：一条事件曾因此涨到 20~29 KB，
     * 而账本是审计日志、页面只需要看「压了几轮、裁了几个」。老行的大 details 照旧可读。
     */
    details?: {
        /** 被丢弃的轮（只存摘要 + 指针；**v5 起不再写**，改读 `droppedCount`） */
        dropped?: DroppedTurnDetail[];
        /** 被裁剪的工具输出（只对保留部分生效；原文落盘可寻回；**v5 起不再写**，改读 `clippedIds`） */
        clipped?: ClippedToolDetail[];
        /** **v5**：被丢弃的轮数（= `size.droppedTurns`，冗余一份便于 UI 单读 details；明细现场从 ops 算） */
        droppedCount?: number;
        /** **v5**：被裁剪的工具输出 —— 只留 id 清单 + 条数（单项明细现场从 ops 算；id 是原文落盘的寻回键） */
        clippedIds?: ClippedIdsSummary;
        /**
         * **预算算法的过滤器表达**：保留的消息行号区间（1-based，等于 llm.jsonl 物理行号）。
         * 历史回溯 / 对比时据此还原那次投递了哪些消息（diff 的"保留侧"），不需要重放当前配置。
         */
        kept?: [number, number][];
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
    // v2（无 plan）/ v3（带 plan 快照）都已是分组形状 —— 原样透传；只有 v1 平铺要归一。
    if (e.v !== 1) return e as CompactEventRecord;
    const v1 = e as CompactEventRecordV1;
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
            // 读侧归一：v1 平铺账 → v2 分组（旧账本无需迁移，下游只见一种形状）；
            // policy 也统一走 normalizePolicy（v2 扁平 / v1 旧形 → v3 modeData）——下游 accessor 只认一种。
            if (e.kind === "compact") {
                const rec = normalizeCompactEvent(e);
                out.push({ ...rec, policy: normalizePolicy(rec.policy) });
            } else {
                out.push(e as CompactLogEvent);
            }
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
    /** 保留起点在 llm.jsonl 里的行号（1-based；缺省 = 旧账，读取侧退回全量） */
    keptFromLlmLine?: number;
    /** 压缩那一刻 ops.jsonl 的完整行字节数（起点自证；缺省 = 旧账，不做截断判定） */
    opsBytes?: number;
    /** 账本格式代号（缺省 = 旧账，按 `OPS_SCHEMA_CURRENT` 读） */
    schema: number;
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
        ...(c.boundary.keptFromLlmLine !== undefined ? { keptFromLlmLine: c.boundary.keptFromLlmLine } : {}),
        ...(c.boundary.opsBytes !== undefined ? { opsBytes: c.boundary.opsBytes } : {}),
        schema: c.schema ?? OPS_SCHEMA_CURRENT,
        // 读侧归一：旧账本里可能是扁平输入面形状（budgetBytes/toolResult/headtail），
        // 这里统一成决策树 —— 于是「历史账本」与「新写的账本」下游完全同形（初版紧凑、扩展松散）。
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
 *
 * ⚠️ `##271 N9` 已删其**生产调用点**（投递不再按边界切片）；当前**仅测试引用**（保留以备核对）。
 * review 2026-10-08 备注：可随手清，或再长出用途时保留。
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

// ─── ⑤ 压缩事件（历史页的数据源）────────────────────
//
// 【用户 2026-10-07】分代（generations）已删除：它把会话切成**连续轮**的段，前提是"保留=一段连续轮"，
// 而目标式预算的保留是**分散**的（纵向优先级跨轮挑选），连续段表达不了。
//
// 新模型：**历史 = 固定的消息集合**；一次压缩 = 用**某算法**对它定义的一个**过滤条件**。
// 于是要记两样（都在 CompactEventRecord.policy 里）：
//   · **算法**（`mode`：现役只有 `budget`）—— 换算法 = 加新分支 + 新 filter 形状（判别式联合）；
//   · 该算法的**过滤器表达**（旧口径是 budgetBytes+toolResult；现在是 turns.jsonl 里的边界）。
// 历史页列的就是这些**不可变快照**；当前配置对历史回溯**无效**（回溯只看当时那条事件）。

/**
 * 粗略 token 估算：**字节 / 4**（无 tokenizer；用于 inputGate / request-preflight / step-request 等
 * 「够不够装」的粗判，绝不用于计费）。
 *
 * ⚠️ **两套口径并存（已知遗留）**：另一处是 `history-limit.ts::estimateTokensOf`（CJK 码点 1 token/字、
 * 其余 /4）—— 它只喂**历史压缩边界**，因为压缩要跟配置里的 token 上限比，中文必须不低估 4 倍。
 * 本函数一律按字节 /4 ⇒ 中文会话上会**低估约 3~4 倍**（中文 3 字节/字 ⇒ 实际 token ≈ 字节/3）。
 * 后果：中文会话里「预检说不超、压缩说超」。为什么暂不统一：inputGate / preflight 的阈值是按本口径
 * 标定的，改成 CJK 感知要同时重标定阈值（改动面大，记在 ##432 body 的遗留项里）。改之前**别只改一个**。
 */
export function estimateTokens(bytes: number): number {
    return Math.round(bytes / 4);
}

// ─── ⑥ 压缩状态快照（`compact-state.json`，##431）────────────────────
//
// 为什么另立一个**当前值文件**（而不是继续从账本流水推）：
//   · 账本是 append-only 流水，且每条曾达 20~29 KB（266 会话实测 274 MB）—— 「现在生效的边界是什么」
//     这个**每步投递都要问**的问题，原来要靠「倒着扫账本尾部」回答，账本一大就顶到主线程；
//   · 当前值只有一个：`{ boundary, at, opIds, measure }`，几百 B。原子覆盖写（tmp + rename），
//     读它 O(1)。账本从此降级为**纯审计日志**：删了 / 坏了只丢历史，不影响 agent 跑（回落扫一次 + 懒迁移）。
//
// 判据边界（用户 2026-10-25）：「主要是想把 compact.jsonl 变为和 ops 一样的非核心依赖，就是日志」。
// 故本文件的**唯一用途**是「生成的快照」—— 真源仍是账本；快照丢了就按账本重建，重建结果必须与之等价。

/** 状态快照的文件名（会话目录下的旁路 JSON，不是 jsonl 流水） */
export const COMPACT_STATE_FILENAME = "compact-state.json";

/**
 * 一次压缩的**当前值**（从账本条目提取，纯数据）。
 * 与 `EffectiveBoundary` 的区别：多带 `at`（账本条目的字节偏移，供审计 / 后续读取），少了「从账本再推一遍」的成本。
 */
export interface CompactPointState {
    compactId: string;
    /** 账本格式代号（缺省 = 旧账，按 `OPS_SCHEMA_CURRENT` 读） */
    schema: number;
    keptFromTurnId: string | null;
    keepFromOpIndex: number;
    keptFromOpsOffset?: number;
    keptFromLlmLine?: number;
    opsBytes?: number;
    /** 该 compact 行在账本里的字节偏移（可选；只用于回查，不影响重放起点） */
    at?: number;
    /** 压缩时刻（= compact id 的同源时间戳） */
    ts: string;
    /** 当时的旋钮（`resolveBoundary` 的对外形状要求它，故一并快照） */
    policy: CompactPolicy;
}

/** `compact-state.json` 的内容（v1） */
export interface CompactState {
    v: 1;
    /** **当前生效**的边界；`null` = 账本在但没有生效压缩（从未压过 / 全被 undo） */
    boundary: CompactPointState | null;
    /** 当前工作集引用过的工具原文 id（`clear()` 与落位迁移的归属判据；新事件只写 ids） */
    opIds: string[];
    /** 最近一次 measure（可选；缺失只是少一条统计，不影响任何行为） */
    measure?: MeasureEventRecord;
    /** 快照生成时刻（ISO；排查用） */
    savedAt?: string;
}

/** 账本条目 → 当前值快照点（`at` = 该行在账本里的字节偏移） */
export function compactPointOf(rec: CompactEventRecord, at?: number): CompactPointState {
    return {
        compactId: rec.id,
        schema: rec.schema ?? OPS_SCHEMA_CURRENT,
        keptFromTurnId: rec.boundary.keptFromTurnId,
        keepFromOpIndex: rec.boundary.keepFromOpIndex ?? -1,
        ...(rec.boundary.keptFromOpsOffset !== undefined ? { keptFromOpsOffset: rec.boundary.keptFromOpsOffset } : {}),
        ...(rec.boundary.keptFromLlmLine !== undefined ? { keptFromLlmLine: rec.boundary.keptFromLlmLine } : {}),
        ...(rec.boundary.opsBytes !== undefined ? { opsBytes: rec.boundary.opsBytes } : {}),
        ...(at !== undefined ? { at } : {}),
        ts: rec.ts,
        policy: normalizePolicy(rec.policy),
    };
}

/** 当前值快照点 → `EffectiveBoundary`（下游只认这一种形状，与 `resolveBoundary` 逐字段同构） */
export function boundaryOfPoint(p: CompactPointState): EffectiveBoundary {
    return {
        compactId: p.compactId,
        keptFromTurnId: p.keptFromTurnId,
        keepFromOpIndex: p.keepFromOpIndex,
        ...(p.keptFromOpsOffset !== undefined ? { keptFromOpsOffset: p.keptFromOpsOffset } : {}),
        ...(p.keptFromLlmLine !== undefined ? { keptFromLlmLine: p.keptFromLlmLine } : {}),
        ...(p.opsBytes !== undefined ? { opsBytes: p.opsBytes } : {}),
        schema: p.schema,
        policy: normalizePolicy(p.policy),
        ts: p.ts,
    };
}

/** 一条 compact 事件引用过的工具原文 id（v5 的 `clippedIds` 优先；老行回落 `clipped` 明细） */
export function clippedIdsOfEvent(rec: CompactEventRecord): string[] {
    const out = new Set<string>();
    for (const id of rec.details?.clippedIds?.ids ?? []) if (typeof id === "string" && id) out.add(id);
    for (const c of rec.details?.clipped ?? []) if (typeof c?.id === "string" && c.id) out.add(c.id);
    return [...out];
}

/**
 * 宽松校验磁盘上的 `compact-state.json`（外部输入，坏形状 = null，由调用方回落扫账本）。
 *
 * 为什么不在 shared 用 zod：这个形状只有一个消费方（main），且校验判据就是"能不能用"——
 * 用 zod 会把 shared 变成 schema 定义处，而账单的可选字段一多，schema 就比校验函数更长。
 */
export function normalizeCompactState(raw: unknown): CompactState | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (o["v"] !== 1) return null;
    const b = o["boundary"];
    let boundary: CompactPointState | null = null;
    if (b !== null && b !== undefined) {
        if (typeof b !== "object") return null;
        const p = b as Record<string, unknown>;
        if (typeof p["compactId"] !== "string" || !p["compactId"]) return null;
        if (typeof p["keptFromTurnId"] !== "string" && p["keptFromTurnId"] !== null) return null;
        const num = (k: string): number | undefined => {
            const value = p[k];
            return typeof value === "number" && Number.isFinite(value) ? value : undefined;
        };
        const off = num("keptFromOpsOffset");
        const line = num("keptFromLlmLine");
        const bytes = num("opsBytes");
        const at = num("at");
        boundary = {
            compactId: p["compactId"],
            schema: num("schema") ?? OPS_SCHEMA_CURRENT,
            keptFromTurnId: (p["keptFromTurnId"] as string | null) ?? null,
            keepFromOpIndex: num("keepFromOpIndex") ?? -1,
            ...(off !== undefined ? { keptFromOpsOffset: off } : {}),
            ...(line !== undefined ? { keptFromLlmLine: line } : {}),
            ...(bytes !== undefined ? { opsBytes: bytes } : {}),
            ...(at !== undefined ? { at } : {}),
            ts: typeof p["ts"] === "string" ? p["ts"] : (p["compactId"] as string),
            policy: normalizePolicy(p["policy"]),
        };
    } else if (b === undefined) {
        return null; // 缺键 ≠ 「无边界」：这是坏文件，交调用方回落
    }
    const ids = Array.isArray(o["opIds"]) ? (o["opIds"] as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : [];
    const measure = o["measure"];
    return {
        v: 1,
        boundary,
        opIds: ids,
        ...(measure && typeof measure === "object" ? { measure: measure as MeasureEventRecord } : {}),
        ...(typeof o["savedAt"] === "string" ? { savedAt: o["savedAt"] } : {}),
    };
}
