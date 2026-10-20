// src/main/services/local-find.ts
// 🎯 会话数据层检索（##389）：在 **ops.jsonl 原文** 里找字，与 DOM / 渲染窗口无关。
//
// 为什么必须在 main 侧扫文件、而不是在渲染端的块树里找：
//   · 渲染端 store 只有一个**窗口**（首载 4MB + 上滚补段，见 localChatStore 的 HISTORY_WINDOW_BYTES）
//     —— 窗口外的轮压根不在内存里，在渲染端找就是"换一个地方犯同一个错"；
//   · 真相源是 append-only 的 ops.jsonl，压缩也**不搬文件、不 rm**（见 local-agent 的压缩三句话）
//     ⇒ 扫原文天然覆盖「已压缩掉的历史」。
//
// 判据（正确性靠这三条，别改成"扫原始行找子串"）：
//   1. **按轮折好再找**：正文是逐 token 一条 `delta` 追加的，同一个词极可能被切在两条 delta 里
//      （`{content:"止"}` + `{content:"扰"}`）—— 原始行里根本没有连续的"止扰"。
//      故每轮用 BlockStore 折一遍（与 UI 同一份 apply 语义），在**块字段的完整文本**上找。
//   2. **单轮折叠、轮间丢弃**：内存峰值为一轮，不随文件长度增长（74MB 会话也不炸）；
//      长轮里的巨型 tool 输出只在那一轮期间存在。
//   3. **不阻塞 main**：每折若干轮让一次事件循环、且支持中途取消 —— 检索在主进程跑，
//      一次同步扫完 74MB 会把整棵 RPC 面卡死（UI 输入、流式推送全靠它）。
//
// 命中里的 `at` = 该轮 `start` 行的**字节偏移**：段跳（`historyAt`）与「已压缩」判定都用它，
// 与游标同一套字节语义（`isTurnStartAt` 可复核）。
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { BlockStore, type Block, type BlockKind, type Op } from "./local-blocks";

/** 检索范围（面板上的三个勾）：正文 / 工具（参数+输出）/ 推理。缺省 = 正文 + 工具（推理默认关）*/
export interface FindScopes {
    text: boolean;
    tool: boolean;
    think: boolean;
}

export interface FindHit {
    /** 所属轮次 id（`t<epochms>` / 测试里的 `v*`） */
    turnId: string;
    /** 该轮 `start` 行的字节偏移（段跳与「已压缩」判定的锚） */
    at: number;
    /** 命中的块 id（定位到该轮后可据此在 DOM 里找块） */
    blockId: string;
    kind: BlockKind;
    scope: keyof FindScopes;
    /** 命中前后的上下文（已压成单行；`hit` 是原文命中片段，大小写照原文） */
    pre: string;
    hit: string;
    post: string;
    /** 这块内容在 UI 上的称呼（"你" / "助理" / 工具名 / "推理" / "错误"） */
    label: string;
    /** 命中落在**不投递**的历史里（该轮早于最近一次压缩的保留边界） */
    compacted: boolean;
}

export interface FindOptions {
    query: string;
    scopes?: Partial<FindScopes>;
    /** 最多收集多少**轮**（面板的组数上限）；到顶即停，`more` 为 true */
    maxTurns?: number;
    /** 单轮内最多收集多少条命中（一轮刷屏没意义，也是防爆内存的闸） */
    maxPerTurn?: number;
    /** 命中前后各留多少字符 */
    context?: number;
    /** 压缩保留边界的字节偏移（`at` 小于它 = 该轮不投递给模型）；null/缺省 = 没压缩过 */
    compactedBefore?: number | null;
    /** 压缩边界的轮 id 兜底（旧账没有字节偏移时按轮序判） */
    compactedFromTurnId?: string | null;
    /** 中途取消（渲染端每次输入都会换一个 token，旧扫必须停） */
    signal?: AbortSignal;
}

export interface FindResult {
    hits: FindHit[];
    /** 有命中的轮数（受 maxTurns 约束：到顶即停，故 ≤ maxTurns） */
    turns: number;
    /** 还有更多命中没收集（撞到 maxTurns） */
    more: boolean;
    /** 实际折了多少轮 / 多少字节（诊断用：慢的时候一眼看出是不是把整份扫了） */
    scannedTurns: number;
    scannedBytes: number;
}

const DEFAULTS = {
    maxTurns: 200,
    maxPerTurn: 20,
    context: 40,
    /** 每折这么多轮让一次事件循环（一轮平均几 KB~几 MB，让得太密反而拖慢） */
    yieldEveryTurns: 20,
} as const;

/** 一次扫描的分块大小：跨块半行要拼接，1MB 足够摊薄 syscall 又不至于留大尾巴 */
const READ_CHUNK = 1 << 20;

/** 按行流式读 `[0, EOF)`：给出行文本与**行首字节偏移**（半行跨块拼接，JSON 不按字节切） */
function* linesOf(fp: string): Generator<{ line: string; at: number }, void, void> {
    const fd = openSync(fp, "r");
    try {
        const buf = Buffer.allocUnsafe(READ_CHUNK);
        let carry: Buffer = Buffer.alloc(0);
        let carryAt = 0; // carry 首字节在文件里的偏移
        for (;;) {
            let got = 0;
            try {
                got = readSync(fd, buf, 0, READ_CHUNK, null);
            } catch {
                break;
            }
            if (got <= 0) break;
            const chunk = buf.subarray(0, got);
            const piece = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
            let start = 0;
            for (let i = 0; i < piece.length; i++) {
                if (piece[i] !== 0x0a) continue;
                yield { line: piece.subarray(start, i).toString("utf-8"), at: carryAt + start };
                start = i + 1;
            }
            carry = piece.subarray(start);
            carryAt += start;
        }
        if (carry.length > 0) yield { line: carry.toString("utf-8"), at: carryAt };
    } finally {
        closeSync(fd);
    }
}

/** 单行 → Op（坏行跳过：与 local-agent 的 readOpsRange 同策略，一条坏行不该吃掉整轮） */
function parseOp(line: string): Op | null {
    const t = line.trim();
    if (!t) return null;
    try {
        return JSON.parse(t) as Op;
    } catch {
        return null;
    }
}

/** 文本压成单行（列表/上下文一律回车 = 一条命中一行，UI 不必再处理换行） */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** 截一段上下文：`pre`/`post` 各自压行 —— 压行会改长度，故按"原串"截好再压，不做下标回算 */
function contextOf(text: string, idx: number, len: number, ctx: number) {
    const from = Math.max(0, idx - ctx);
    const to = Math.min(text.length, idx + len + ctx);
    return {
        pre: (from > 0 ? "…" : "") + oneLine(text.slice(from, idx)),
        hit: oneLine(text.slice(idx, idx + len)),
        post: oneLine(text.slice(idx + len, to)) + (to < text.length ? "…" : ""),
    };
}

/** 一个块里值得检索的文本字段：`[scope, 字段值, 称呼]` */
function fieldsOf(b: Block): Array<[keyof FindScopes, string, string]> {
    const out: Array<[keyof FindScopes, string, string]> = [];
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    switch (b.kind) {
        case "text": {
            // author：代发 / 多 agent 同席（##166）—— 谁说的话在结果列表里必须认得出
            const role = str(b.role);
            const who = str(b.author);
            const label = who || (role === "user" ? "你" : "助理");
            out.push(["text", str(b.content), label]);
            break;
        }
        case "think":
            out.push(["think", str(b.content), "推理"]);
            break;
        case "tool":
            // 参数与输出同属"工具"：用户找的是"我当时让它跑了什么 / 它回了什么"，
            // 拆成两个勾只会让人猜错（而 input 通常很短，噪声可忽略）
            out.push(["tool", str(b.input), str(b.title) || str(b.tool) || "工具"]);
            out.push(["tool", str(b.output), str(b.title) || str(b.tool) || "工具"]);
            break;
        case "plan": {
            const items = Array.isArray(b.items) ? (b.items as Array<{ text?: unknown }>) : [];
            const text = items.map((it) => str(it?.text)).filter(Boolean).join("\n");
            out.push(["text", text, "计划"]);
            break;
        }
        case "error":
            out.push(["text", str(b.message), "错误"]);
            break;
        default:
            break; // turn / step 自身不带正文
    }
    return out;
}

/**
 * 在 ops.jsonl 里找字。**异步**：每折若干轮让一次事件循环，`signal` 一断立刻收手
 * （渲染端每次输入都会换 token —— 旧扫必须能停，否则打字时主进程排一串全量扫）。
 */
export async function findInOpsFile(fp: string, opts: FindOptions): Promise<FindResult> {
    const out: FindResult = { hits: [], turns: 0, more: false, scannedTurns: 0, scannedBytes: 0 };
    const q = opts.query.trim().toLowerCase();
    if (!q) return out;
    const scopes: FindScopes = { text: true, tool: true, think: false, ...opts.scopes };
    const maxTurns = opts.maxTurns ?? DEFAULTS.maxTurns;
    const maxPerTurn = opts.maxPerTurn ?? DEFAULTS.maxPerTurn;
    const ctx = opts.context ?? DEFAULTS.context;
    const compactedBefore = opts.compactedBefore ?? null;
    const compactedFromTurnId = opts.compactedFromTurnId ?? null;

    let fdSize = 0;
    try {
        fdSize = statSync(fp).size;
    } catch {
        return out; // 没有日志 = 没有命中（不是错）
    }
    out.scannedBytes = fdSize;

    /** 当前轮的累积 */
    let turnId: string | null = null;
    let turnAt = 0;
    let ops: Op[] = [];
    /** 压缩边界（按轮序兜底）：一旦撞到 boundary 轮，此后都算"已压缩" */
    let seenBoundary = compactedFromTurnId === null;

    const isCompacted = (at: number): boolean =>
        compactedBefore !== null ? at < compactedBefore : !seenBoundary;

    /** 折一轮 → 收集命中 */
    const flush = (): boolean => {
        out.scannedTurns++;
        if (turnId === null || ops.length === 0) return false;
        const tid = turnId;
        const at = turnAt;
        const compacted = isCompacted(at);
        const store = new BlockStore();
        for (const op of ops) store.apply(op);
        const hits: FindHit[] = [];
        for (const b of store.blocks.values()) {
            if (b.kind === "turn" || b.kind === "step") continue;
            for (const [scope, text, label] of fieldsOf(b)) {
                if (!scopes[scope] || !text) continue;
                const hay = text.toLowerCase();
                for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
                    const c = contextOf(text, i, q.length, ctx);
                    hits.push({ turnId: tid, at, blockId: b.id, kind: b.kind, scope, ...c, label, compacted });
                    if (hits.length >= maxPerTurn) break;
                }
                if (hits.length >= maxPerTurn) break;
            }
            if (hits.length >= maxPerTurn) break;
        }
        if (hits.length === 0) return false;
        out.hits.push(...hits);
        out.turns++;
        return true;
    };

    let pending = 0;
    for (const { line, at } of linesOf(fp)) {
        if (opts.signal?.aborted) throw abortError();
        const op = parseOp(line);
        if (!op) continue;
        if (op.op === "start" && op.kind === "turn") {
            if (turnId !== null && flush()) {
                if (out.turns >= maxTurns) {
                    out.more = true;
                    return out;
                }
            }
            if (!seenBoundary && op.id === compactedFromTurnId) seenBoundary = true;
            turnId = op.id;
            turnAt = at;
            ops = [op];
            if (++pending >= DEFAULTS.yieldEveryTurns) {
                pending = 0;
                await yieldNow(); // 让一次事件循环：主进程还扛着 RPC 与流式推送
            }
            continue;
        }
        if (turnId !== null) ops.push(op);
    }
    flush(); // 末轮
    return out;
}

/** 让一次事件循环（setImmediate 而非 setTimeout(0)：不插队到定时器队列后面） */
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

function abortError(): Error {
    const e = new Error("检索已取消");
    e.name = "AbortError";
    return e;
}
