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

// ─── ① 策略 ───────────────────────────────────────────

/** 工具输出的处理方式（只作用于**投递**，UI 与落盘永远保留原文） */
export type ToolOutputMode =
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

export interface CompactPolicy {
    /** 保留最近多少**轮**（turn）；0 = 全部清零（会话硬切换） */
    keepTurns: number;
    toolOutput: ToolOutputMode;
    headtail: HeadTailPolicy;
    /** 是否额外算一份历史摘要带进新会话 */
    summary: boolean;
}

export const DEFAULT_COMPACT_POLICY: CompactPolicy = {
    keepTurns: DEFAULT_KEEP_TURNS,
    toolOutput: "asis",
    headtail: DEFAULT_HEADTAIL,
    summary: false,
};

/** 宽松校验：从 UI/CLI 来的策略（可能缺字段/越界）→ 合法策略 */
export function normalizePolicy(p: Partial<CompactPolicy> | undefined | null): CompactPolicy {
    const src = p ?? {};
    const ht = { ...DEFAULT_HEADTAIL, ...(src.headtail ?? {}) };
    const pos = (v: unknown, d: number, min = 0): number =>
        typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : d;
    return {
        keepTurns: pos(src.keepTurns, DEFAULT_KEEP_TURNS, 0),
        toolOutput:
            src.toolOutput === "headtail" || src.toolOutput === "callpath" ? src.toolOutput : "asis",
        headtail: (() => {
            const headLines = pos(ht.headLines, DEFAULT_HEADTAIL.headLines, 0);
            const tailLines = pos(ht.tailLines, DEFAULT_HEADTAIL.tailLines, 0);
            return {
                // 阈值一律由 head+tail 推出（UI 不再单列「超过 N 行」输入项）
                triggerLines: headLines + tailLines,
                headLines,
                tailLines,
                maxLineChars: pos(ht.maxLineChars, DEFAULT_HEADTAIL.maxLineChars, 1),
                maxKeepBytes: pos(ht.maxKeepBytes, DEFAULT_HEADTAIL.maxKeepBytes, 1),
            };
        })(),
        summary: src.summary === true,
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
 * 按策略裁一段工具输出。
 *
 * 设计要点：
 *   · **未触发裁条件时逐字符返回原文** —— 不"顺手规整"，否则 86% 不受影响的输出会和历史分叉；
 *   · 行数触发是主判据（阈值 ≈ p90），字节兜底只防"一行超长"（压缩 JSON / base64）；
 *   · marker 里**必须**给原文路径（##127 的「头尾保留 + marker + 原文可寻回」三件套），
 *     否则模型看到「中间省略」却无处可查，只能重跑一遍命令（那是真金白银）。
 */
export function clipToolOutput(
    text: string,
    policy: Pick<CompactPolicy, "toolOutput"> & { headtail: HeadTailPolicy },
    opts: ClipOpts = {},
): ToolClipResult {
    const ht = policy.headtail;
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

    if (policy.toolOutput === "asis") return same();

    const lines = text.split("\n");
    const pathHint = opts.origPath ? `完整输出见 ${opts.origPath}` : "完整输出已省略";

    if (policy.toolOutput === "callpath") {
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

    // headtail
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
    transformToolOutput?: (b: { id: string; tool: string; title: string; output: string }) => string;
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
    if (policy.toolOutput !== "asis") {
        opts.transformToolOutput = ({ id, output }) => {
            const r = clipToolOutput(output, policy, { origPath: origPathOf(id) });
            if (!r.clipped) return output;
            collect?.push({
                id,
                tool: "",
                mode: policy.toolOutput,
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
    provider?: string;
    model?: string;
    /** 全价（$/1M） */
    input: number;
    /** 缓存读价（$/1M） */
    cacheRead: number;
    /** k = 全价 ÷ 缓存读价（回本公式的分子；k=50 → 砍一半要 49 步回本） */
    k: number;
    asOf?: string;
}

export interface CompactBoundaryRecord {
    /** 保留起点轮 id（null = 全部清零，新会话从零开始） */
    keptFromTurnId: string | null;
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
    mode: ToolOutputMode;
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
    /** 摘要文本（勾选 summary 时） */
    summaryText?: string | null;
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
        ...(c.boundary.keptFromOpsOffset !== undefined
            ? { keptFromOpsOffset: c.boundary.keptFromOpsOffset }
            : {}),
        policy: c.policy,
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
