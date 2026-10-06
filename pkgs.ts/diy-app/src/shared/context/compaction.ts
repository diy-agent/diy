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

/** 默认保留轮数（用户可在 panel 里调；0 = 全部清零） */
export const DEFAULT_KEEP_TURNS = 6;

// ─── 策略的**三条正交轴**（用户 2026-10-06 定）─────────────────────────
//
// 为什么拆轴：原先扁平形状里「工具结果处理」与 `headtail` 是**平级兄弟字段**，于是 headtail 恒在，
// 哪怕 render="asis"（它是 headtail 分支的私有参数，却挂在外面 → 语义泄漏、看 JSON
// 也看不出谁属于谁）。三条轴各自独立，参数收进各自分支 → **看 JSON 就懂结构**（D5 命名
// 规范：结构即语义）。同时把"轮次是唯一安全单位"这个隐含假设显式化（keep.unit）。
//
// 与旧（扁平）形状的关系：**输入面**（RPC / CLI / UI）暂时仍是扁平的
// （keepTurns / toolResult / headtail / summary）—— `normalizePolicy` 是唯一适配点，
// 两种形状都收；`flatPolicyOf` 供 UI 回读。存储与内部一律用三轴形状。

/** ① 范围轴：留多久（轮 = 安全单位，不会切开 tool-call/result 配对；消息条数会自动吸附到轮首） */
export const KeepPolicySchema = z.object({
    unit: z.enum(["turns", "messages"]).describe("保留单位：turns（轮，安全单位）或 messages（条数，自动吸附到轮首）"),
    /**
     * 保留数量。三态（**注意别把 all 与 0 搞混 —— 一个是全留、一个是全丢**）：
     *   · 数字 > 0 → 保留最近这么多（单位见 unit）
     *   · `"all"`  → **全留轮次**（配合 `content != "all"` 用：只裁内容、不裁轮）
     *   · `0`      → 全部清零（会话硬切换）
     * `"all"` 的存在理由：自动压缩的默认策略是「保留**所有**轮次的结论」（用户 2026-10-06）——
     * 轮数随会话变，写死数字要么裁掉结论、要么留不住；`all` 才是准确表达。
     */
    count: z
        .union([
            // coerce：CLI 把选项当字符串传（`--keep-turns 1`），不 coerce 的话 union 直接判非法
            // （实测：exit=2 "keepTurns: Invalid input"）。RPC/账本传数字时 coerce 是恒等变换。
            z.coerce.number().describe("保留最近 N（0 = 全部清零）"),
            z.literal("all").describe("全留轮次（配合 content 只裁内容）"),
        ])
        .describe('保留数量：数字 = 保留最近 N；"all" = 全留轮次；0 = 全部清零'),
});

/** ② 内容轴：留过程还是只留结论 */
export const ContentPolicySchema = z
    .enum(["all", "text", "conclusion"])
    .describe("all=用户+助手文本+工具链路；text=只留用户与助手文本；conclusion=每轮只留用户+最后一条助手文本");

/**
 * ③ 工具**结果**轴：判别式联合，参数收进分支（看 JSON 即知关系）。
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

export const CompactPolicySchema = z.object({
    keep: KeepPolicySchema,
    content: ContentPolicySchema,
    toolResult: ToolResultPolicySchema,
    summary: z.boolean().describe("是否额外算一份历史摘要带进新会话"),
});

export type KeepPolicy = z.infer<typeof KeepPolicySchema>;
export type ContentPolicy = z.infer<typeof ContentPolicySchema>;
export type ToolResultPolicy = z.infer<typeof ToolResultPolicySchema>;
export type CompactPolicy = z.infer<typeof CompactPolicySchema>;

export const DEFAULT_COMPACT_POLICY: CompactPolicy = {
    keep: { unit: "turns", count: DEFAULT_KEEP_TURNS },
    content: "all",
    toolResult: { render: "asis" },
    summary: false,
};

/** 扁平（输入面）形状：RPC / CLI / UI 的现有契约，**不是**内部形状 */
export interface FlatCompactPolicy {
    keepTurns: number | "all";
    toolResult: ToolResultMode;
    headtail: HeadTailPolicy;
    summary: boolean;
    content?: ContentPolicy;
    keepUnit?: "turns" | "messages";
}

/** 三轴 → 扁平（UI 回读 / 旧契约输出用） */
export function flatPolicyOf(p: CompactPolicy): FlatCompactPolicy {
    const t = p.toolResult;
    const ht =
        t.render === "headtail"
            ? {
                  triggerLines: t.head + t.tail,
                  headLines: t.head,
                  tailLines: t.tail,
                  maxLineChars: t.maxLineChars,
                  maxKeepBytes: t.maxKeepBytes,
              }
            : { ...DEFAULT_HEADTAIL };
    return {
        keepTurns: p.keep.count,
        toolResult: t.render,
        headtail: ht,
        summary: p.summary,
        content: p.content,
        keepUnit: p.keep.unit,
    };
}

const posNum = (v: unknown, d: number, min = 0): number =>
    typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : d;

/**
 * 宽松校验：从 UI/CLI/旧账本来的策略 → 合法三轴策略。
 * **两种形状都收**（初版紧凑、扩展松散）：旧扁平（keepTurns/toolResult/headtail）与新三轴。
 * 判据看有没有 `keep` —— 有就当新形状，否则按扁平解。
 */
export function normalizePolicy(p: unknown): CompactPolicy {
    const src = (p ?? {}) as Record<string, unknown>;
    const keep0 = src["keep"] as Partial<KeepPolicy> | undefined;
    const ht0 = (src["headtail"] ?? {}) as Partial<HeadTailPolicy>;
    const legacyCount = src["keepTurns"];
    const unit = keep0?.unit === "messages" || src["keepUnit"] === "messages" ? "messages" : "turns";
    const rawCount = keep0?.count ?? legacyCount;
    // 数字也可能是字符串（CLI/手写 YAML 都常见）—— 宽松收，"初版紧凑、扩展松散"
    const numOf = (v: unknown): number | null => {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
        if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v);
        return null;
    };
    // ⚠️ 负数**不**夹成 0：0 是「全部清零」（会话硬切换），而负数只可能是笔误/脏数据 ——
    //    把 -1 解成"清空会话"是灾难性误读，故一律回落缺省（6）。
    const count: number | "all" = rawCount === "all" ? "all" : (numOf(rawCount) ?? DEFAULT_KEEP_TURNS);

    const content0 = src["content"];
    const content: ContentPolicy =
        content0 === "text" || content0 === "conclusion" ? content0 : "all";

    const t0 = src["toolResult"];
    let toolResult: ToolResultPolicy;
    if (t0 !== null && typeof t0 === "object") {
        // 已经是分支形状（新）：只校验判别键
        // 判别键：新形状 `render`，旧形状 `mode`（扩展松散）
        const m = (t0 as { render?: unknown }).render ?? (t0 as { mode?: unknown }).mode;
        toolResult =
            m === "headtail"
                ? {
                      render: "headtail",
                      head: posNum((t0 as { head?: unknown }).head, DEFAULT_HEADTAIL.headLines, 0),
                      tail: posNum((t0 as { tail?: unknown }).tail, DEFAULT_HEADTAIL.tailLines, 0),
                      maxLineChars: posNum((t0 as { maxLineChars?: unknown }).maxLineChars, DEFAULT_HEADTAIL.maxLineChars, 1),
                      maxKeepBytes: posNum((t0 as { maxKeepBytes?: unknown }).maxKeepBytes, DEFAULT_HEADTAIL.maxKeepBytes, 1),
                  }
                : m === "callpath"
                  ? { render: "callpath" }
                  : { render: "asis" };
    } else if (t0 === "headtail") {
        const head = posNum(ht0.headLines, DEFAULT_HEADTAIL.headLines, 0);
        const tail = posNum(ht0.tailLines, DEFAULT_HEADTAIL.tailLines, 0);
        toolResult = {
            render: "headtail",
            head,
            tail,
            maxLineChars: posNum(ht0.maxLineChars, DEFAULT_HEADTAIL.maxLineChars, 1),
            maxKeepBytes: posNum(ht0.maxKeepBytes, DEFAULT_HEADTAIL.maxKeepBytes, 1),
        };
    } else if (t0 === "callpath") {
        toolResult = { render: "callpath" };
    } else {
        toolResult = { render: "asis" };
    }
    return { keep: { unit, count }, content, toolResult, summary: src["summary"] === true };
}

/**
 * keep 轴 → 保留轮数（**唯一入口**：turns / messages / "all" 三态都在这收口，
 * 免得每个调用点各写一遍 `count === 0 ? 0 : …` 而漏掉 `"all"`）。
 *
 *   · count = "all"  → 全留（轮数 = 全部）
 *   · count = 0      → 全丢（会话硬切换）
 *   · unit=turns     → min(count, 总轮数)
 *   · unit=messages  → 取尾 count 条消息后吸附到轮首（见 keptTurnsByMessageCount）
 */
export function keptTurnsOf(
    keep: KeepPolicy,
    turnIds: readonly string[],
    messageTurns: readonly string[],
): number {
    if (keep.count === "all") return turnIds.length;
    if (keep.unit === "turns") return Math.min(keep.count, turnIds.length);
    return keptTurnsByMessageCount(messageTurns, keep.count, turnIds);
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
    sinceTurnId?: string | null;
    /** 内容轴：留过程还是只留结论（选择阶段的判据，见 local-blocks 的 selectHistory） */
    content?: ContentPolicy;
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
    if (keptFromTurnId !== undefined) opts.sinceTurnId = keptFromTurnId;
    // 内容轴随策略一起下发（选择阶段用）；"all" 是缺省、不必写
    if (policy.content !== "all") opts.content = policy.content;
    if (policy.toolResult.render !== "asis") {
        opts.transformToolResult = ({ id, output }) => {
            const r = clipToolResult(output, policy.toolResult, { origPath: origPathOf(id) });
            if (!r.clipped) return output;
            collect?.push({
                id,
                tool: "",
                render: policy.toolResult.render,
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

export interface CompactEventRecord {
    kind: "compact";
    v: 1;
    /** 压缩 id（= ts，供 measure / undo 回指） */
    id: string;
    ts: string;
    by: "ui" | "cli";
    policy: CompactPolicy;
    boundary: CompactBoundaryRecord;
    before: SizeSnapshot;
    after: SizeSnapshot;
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
    droppedDetail?: DroppedTurnDetail[];
    clipped?: ClippedToolDetail[];
    /** 摘要文本（勾选 summary 且已生成；走 summary.md 模版渲染） */
    summaryText?: string | null;
    /** 摘要的结构化数据（再生成/预览占位用；见 shared/context/summary.ts） */
    summaryData?: import("./summary").SummaryData | null;
    summaryCost?: number | null;
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
            const e = JSON.parse(line) as CompactLogEvent;
            if (e && typeof e === "object" && typeof (e as { kind?: unknown }).kind === "string") out.push(e);
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
