/**
 * output-ring.ts — 后台 job 的**输出环 + 双 cursor**：纯函数、零 IO（##408 刀 4）。
 *
 * ── 为什么是「环」而不是「整个输出」──
 *   长时进程的输出可以无限长（`npm i` 刷几万行）。全留 = 吃内存 + 面板一次渲染卡死；
 *   全丢 = 出事后没有任何证据。⇒ **只留尾部 N 字节，丢头**，并把丢了多少**如实记账**
 *   （`droppedBytes`）。少了这个数，UI 就分不清「没有输出」和「输出被截了」——
 *   那是最容易让人误判的一类显示。
 *
 * ── 已知代价：`appendToRing` 是「每块复制整环」（##408 刀 4 review 记下，**暂不优化**）──
 *   每来一个 chunk 都要 `new Uint8Array(len + chunk)` 再两次 `set` ⇒ 长时 job 高频输出
 *   （`npm i` 每行一个 chunk）的代价是 **O(块数 × 环容量)**（≤256KB × 块数）。
 *   现在**不动**它，判据写死在这里，别凭感觉重构：
 *     · 触发条件：接上 bash 工具后**实测**出现面板卡顿 / 主进程掉帧（并给出数字），才改。
 *     · 改法：固定 cap 缓冲 + 首尾索引回绕（写指针环行、读侧按两段 memcpy），对外接口不变。
 *     · 反例：只因为「看着像 O(n²)」就重构 —— 未发生的问题不值得用 bug 风险换。
 *
 * ── 为什么是**字节**不是字符串 ──
 *   输出是流式 chunk，chunk 边界天然可能落在多字节字符中间。若在字符串层截断，
 *   半截 UTF-8 会在 `JSON.stringify` / RPC 里变 `\uFFFD` 或直接抛 —— 下游任何一层都可能崩。
 *   ⇒ 环只存字节；**切点前退到码点边界**（`utf8HeadStart` / `utf8TailCut`），
 *      解出来的一定是完整字符。这条是本刀硬判据③。
 *
 * ── 为什么两个 cursor 各带 id，共用一个会怎样 ──
 *   live（256 KB）跟着面板高频追尾，**可被覆盖**；settle（16 KB）是 run 收口时的稳定快照，
 *   供「离开页面之后回来看」。两者生命周期不同：live 随面板存活，settle 随 run 收口。
 *   共用一个 offset 再靠参数切换，等于让「面板关掉」把回看的位置一起带走 ——
 *   所以 `OutputCursor.id = "<kind>:<runId>"`，两种 kind **各自独立**推进。
 *
 * ── cursor 存的是**绝对流偏移**，不是环内下标 ──
 *   环会丢头（`baseOffset` 前移）。绝对偏移让 cursor 在丢头后仍能判出「我漏了多少字节」
 *   （`lostBytes`），而环内下标会静默指到错的字节上 —— 那种错最难查。
 */

/** live 环容量：高频追尾、可被覆盖（面板存活期） */
export const LIVE_RING_BYTES = 256 * 1024;
/** settle 环容量：run 收口时的稳定快照（离开页面后回看） */
export const SETTLE_RING_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

// ═══════════════════════════════════════════════
//  UTF-8 码点边界（本文件的「合法切点」判据）
// ═══════════════════════════════════════════════

/** UTF-8 续字节（`10xxxxxx`）—— 出现在序列中间，不能当起点。 */
function isContinuation(byte: number): boolean {
    return (byte & 0xc0) === 0x80;
}

/** 由首字节求该序列应有的字节数（非法首字节按 1 处理：不解码也得能走，不许抛）。 */
function sequenceLength(lead: number): number {
    if (lead < 0x80) return 1;
    if (lead >= 0xf0) return 4;
    if (lead >= 0xe0) return 3;
    if (lead >= 0xc0) return 2;
    return 1; // 0x80..0xBF 不应作首字节；当 1 字节跳过，交给 decode 的 replacement 处理
}

/**
 * 头部对齐：把 `from` 推到**码点起点**（跳过游离的续字节）。
 * 返回 (对齐后位置, 跳过字节数)。丢头截断正好切在字符中间时靠它补救。
 */
export function utf8HeadStart(bytes: Uint8Array, from: number): { at: number; skipped: number } {
    let at = Math.max(0, Math.min(from, bytes.length));
    const start = at;
    while (at < bytes.length && isContinuation(bytes[at]!)) at++;
    return { at, skipped: at - start };
}

/**
 * 尾部对齐：把 `to` 退到**完整码点**之后（末尾若是半截序列，则退到它的首字节）。
 * 只影响「这次读出来多少」，**不影响环里存的字节** —— 半个字符留在环里，等下一块 chunk 补齐。
 */
export function utf8TailCut(bytes: Uint8Array, from: number, to: number): number {
    let end = Math.max(from, Math.min(to, bytes.length));
    if (end <= from) return from;
    // 往回找最后一个序列的首字节（最多 3 步续字节）
    let lead = end - 1;
    let steps = 0;
    while (lead > from && isContinuation(bytes[lead]!) && steps < 3) {
        lead--;
        steps++;
    }
    if (isContinuation(bytes[lead]!)) return lead;
    const need = sequenceLength(bytes[lead]!);
    return end - lead < need ? lead : end;
}

// ═══════════════════════════════════════════════
//  环
// ═══════════════════════════════════════════════

export interface OutputRing {
    /** 容量上限（字节） */
    readonly capBytes: number;
    /** 尚在环里的原始字节（**头部可能落在码点中间**，读取时靠 `utf8HeadStart` 对齐） */
    readonly bytes: Uint8Array;
    /** `bytes[0]` 在整个输出流里的绝对字节偏移 */
    readonly baseOffset: number;
    /** 因容量上限**丢掉**的字节总数（含头部半字符） */
    readonly droppedBytes: number;
    /** 曾写入的总字节数（= 当前长度 + droppedBytes） */
    readonly totalBytes: number;
}

export function createOutputRing(capBytes: number): OutputRing {
    const cap = Math.max(1, Math.floor(capBytes));
    return { capBytes: cap, bytes: new Uint8Array(0), baseOffset: 0, droppedBytes: 0, totalBytes: 0 };
}

/** 环尾的绝对偏移 = 「已经收到多少字节」 */
export function ringEndOffset(ring: OutputRing): number {
    return ring.baseOffset + ring.bytes.length;
}

/**
 * 追加一块输出。**只保留尾部 `capBytes`**，超出部分从头丢弃并累计进 `droppedBytes`。
 *
 * 纯函数：不改传入的 ring（旧快照仍可读 —— 面板渲染拿的就是快照）。
 */
export function appendToRing(ring: OutputRing, chunk: Uint8Array): OutputRing {
    if (chunk.length === 0) return ring;
    const merged = new Uint8Array(ring.bytes.length + chunk.length);
    merged.set(ring.bytes, 0);
    merged.set(chunk, ring.bytes.length);

    const totalBytes = ring.totalBytes + chunk.length;
    const overflow = merged.length - ring.capBytes;
    if (overflow <= 0) {
        return { ...ring, bytes: merged, totalBytes };
    }
    const kept = merged.slice(overflow);
    return {
        capBytes: ring.capBytes,
        bytes: kept,
        baseOffset: ring.baseOffset + overflow,
        droppedBytes: ring.droppedBytes + overflow,
        totalBytes,
    };
}

/** 字符串便捷入口（内部统一按 UTF-8 字节处理）。 */
export function appendText(ring: OutputRing, text: string): OutputRing {
    return appendToRing(ring, encoder.encode(text));
}

/**
 * 取环尾最后 `keepBytes` 字节作为**新环**（settle 快照用）。
 *
 * `droppedBytes` 继续累加：快照之后「原来还有多少被丢过」依然可查 —— 否则 settle 视图
 * 会把「只保留了 16 KB」显示成「一共就这么多」。
 */
export function tailOfRing(ring: OutputRing, keepBytes: number): OutputRing {
    const cap = Math.max(1, Math.floor(keepBytes));
    const overflow = Math.max(0, ring.bytes.length - cap);
    return {
        capBytes: cap,
        bytes: ring.bytes.slice(overflow),
        baseOffset: ring.baseOffset + overflow,
        droppedBytes: ring.droppedBytes + overflow,
        totalBytes: ring.totalBytes,
    };
}

// ═══════════════════════════════════════════════
//  cursor（双 cursor 各自独立）
// ═══════════════════════════════════════════════

export type OutputCursorKind = "live" | "settle";

export interface OutputCursor {
    /** 稳定标识：`<kind>:<runId>` —— 两种 kind 永不共用一个游标 */
    readonly id: string;
    readonly kind: OutputCursorKind;
    /** 已读到的**绝对**流偏移（= 下次从这里继续） */
    readonly offset: number;
}

export function outputCursorId(kind: OutputCursorKind, runId: string): string {
    return `${kind}:${runId}`;
}

export function createCursor(kind: OutputCursorKind, runId: string): OutputCursor {
    return { id: outputCursorId(kind, runId), kind, offset: 0 };
}

/**
 * 从 cursor 位置读环。返回**只含新增部分**的文本：
 *
 *   · `lostBytes > 0` —— 环已经丢掉了 cursor 之后、当前环头之前的字节（追尾追丢了）。
 *     UI 必须据此显示「此处有 N 字节已被截断」，而不是假装从头连着。
 *   · `end` —— 是否已读到最新（可以让面板停掉轮询）。
 *   · 新 cursor 只推进到**完整码点**末尾：末尾半截序列留着，下一块 chunk 到了再一起读。
 */
export interface OutputRead {
    readonly text: string;
    readonly cursor: OutputCursor;
    readonly lostBytes: number;
    /** 本次读出的字节数（不含丢失 / 未成形的部分） */
    readonly bytes: number;
    /**
     * cursor 指向了环尾**之后**（换了环 / 环被重建 / 旧快照的 cursor 拿来读新环）——
     * 已无条件夹到环尾。调用方应据此重建视图，而不是把 `text:""` 当成「没有新输出」。
     */
    readonly reset: boolean;
}

export function readOutput(ring: OutputRing, cursor: OutputCursor): OutputRead {
    const end = ringEndOffset(ring);
    const reset = cursor.offset > end;
    // 环头已越过 cursor：中间那段被容量上限吃掉了（含它自己可能切在码点中间）
    // `lostBytes` 是**字节**口径，不是字符：丢头切在字符中间时 `head.skipped` 会算进
    // 那半个字符的 1~3 个字节 ⇒ UI 可能说「丢了 1 字节」，其实是「半个汉字」。无害
    // （下游只需要一个「不连续」的信号 + 一个量级），但别把它当字符数显示。
    const headLost = cursor.offset < ring.baseOffset ? ring.baseOffset - cursor.offset : 0;
    const fromRaw = Math.min(Math.max(cursor.offset, ring.baseOffset), end) - ring.baseOffset;
    const head = utf8HeadStart(ring.bytes, fromRaw);
    const stop = utf8TailCut(ring.bytes, head.at, ring.bytes.length);
    const slice = ring.bytes.subarray(head.at, stop);
    return {
        text: decoder.decode(slice),
        cursor: { ...cursor, offset: ring.baseOffset + stop },
        lostBytes: headLost + head.skipped,
        bytes: slice.length,
        reset,
    };
}

/** cursor 直接跳到环尾（「先清空基线条目」用；不是「标记已读」）。 */
export function cursorAtEnd(cursor: OutputCursor, ring: OutputRing): OutputCursor {
    return { ...cursor, offset: ringEndOffset(ring) };
}

/** 从头读（新建 cursor）—— 注意读到的是**环里还留着的**部分，之前的已在 `droppedBytes` 里。 */
export function cursorAtStart(cursor: OutputCursor, ring: OutputRing): OutputCursor {
    return { ...cursor, offset: ring.baseOffset };
}

// ═══════════════════════════════════════════════
//  一次 run 的两条环
// ═══════════════════════════════════════════════

/**
 * 一次 run 的输出视图：
 *   · `live` —— 边跑边追加，256 KB 上限，受面板追尾巴驱动
 *   · `settle` —— run 收口时**冻结**的快照（16 KB），离开页面后回看靠它
 *
 * run 还在跑时 `settle` 是空环（`frozen:false`）：不许拿半个 live 冒充稳定快照。
 */
export interface RunOutput {
    readonly live: OutputRing;
    readonly settle: OutputRing;
    readonly frozen: boolean;
}

export function createRunOutput(): RunOutput {
    return {
        live: createOutputRing(LIVE_RING_BYTES),
        settle: createOutputRing(SETTLE_RING_BYTES),
        frozen: false,
    };
}

/** 追加输出（只动 live；已冻结的 settle 保持不动 —— 稳定快照不许被后续 chunk 改写）。 */
export function appendRunOutput(prev: RunOutput, chunk: Uint8Array): RunOutput {
    return { ...prev, live: appendToRing(prev.live, chunk) };
}

export function appendRunText(prev: RunOutput, text: string): RunOutput {
    return appendRunOutput(prev, encoder.encode(text));
}

/**
 * run 收口：把 live 尾巴冻成 settle 快照。幂等（已冻结则原样返回）——
 * 收口路径可能被重试 / 重启恢复各碰一次，不该因此把快照改小第二次。
 */
export function freezeRunOutput(prev: RunOutput): RunOutput {
    if (prev.frozen) return prev;
    return { ...prev, settle: tailOfRing(prev.live, SETTLE_RING_BYTES), frozen: true };
}

/** 读 live（默认 cursor）与读 settle（冻结后才可读）。 */
export function readLive(prev: RunOutput, cursor: OutputCursor): OutputRead {
    return readOutput(prev.live, cursor);
}

export function readSettle(prev: RunOutput, cursor: OutputCursor): OutputRead {
    return readOutput(prev.settle, cursor);
}
