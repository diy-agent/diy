/**
 * 流量 —— 把主进程实际发出去的 HTTP 请求和收到的响应留一份，供界面查看。
 *
 * 为什么要有它：出问题时用户只看到一行错误（比如上游偶发 400 只回一句带 trace_id 的话），
 * 却看不到是哪个地址、发了什么、上游回了什么。这里把每一次请求都记下，界面点开就能看。
 *
 * 怎么拿到的：主进程的 fetch 底层是 Node 的 undici，它每发一次请求都会往
 * `node:diagnostics_channel` 广播事件。我们只是旁听这些广播：请求方法 / 地址 / 头 / 正文、
 * 响应状态 / 头 / 正文都能拿到，而且不碰数据流、不改时序，对业务完全无感。
 *
 * 记录在哪：
 *  - 内存里留最近若干条，供界面即时查看（见 snapshot）。
 *  - 每条都追加进磁盘日志 `log/network/YYYY-MM-DD.jsonl`（相对 DIY_HOME，按天切文件，
 *    重启不丢；见 core/traffic-log.ts）。每条记录带它在文件里的位置（rec.log），
 *    界面可按位置只读那一段。
 *
 * 一直开着、不分开关：请求和响应始终记，失败什么时候出现不可预期，事后必须能回看。
 * 正文按「首尾法」有界保留（超长留开头 + 结尾，中间省略，见 BodyBuf）；要看完整正文时
 * 打开「完整捕获」（setFullCapture），此后不再截断。
 *
 * 回调在请求的同步路径上：事件回调是被同步调用的，所以这里只做「复制字节 + 计数」，
 * 绝不 await、绝不抛错（抛出去会连累正常请求）。
 *
 * 归属：优先看请求头 `x-opencode-session`（我们自己发的 LLM 请求带），反查是哪个任务 / 轮次；
 * 没有该头时，按「同一个地址」兜底匹配（同一个 provider 的地址只对应一个运行中的任务）。
 * 其它走 undici 的请求（比如模型配置里的「测试」按钮拉 /models）也会被记下，归属标注为对应
 * 来源（见 noteProbe）。
 */

import { subscribe } from "node:diagnostics_channel";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { appendRecord, readRecord, LOG_DIR_REL, absOf, listFiles, TrafficLogError, type LogLoc } from "./traffic-log";

export { TrafficLogError, type LogLoc };

const CH_CREATE = "undici:request:create";
const CH_REQ_CHUNK = "undici:request:bodyChunkSent";
const CH_HEADERS = "undici:request:headers";
const CH_RES_CHUNK = "undici:request:bodyChunkReceived";
const CH_TRAILERS = "undici:request:trailers";
const CH_ERROR = "undici:request:error";

const CAP_DEFAULT = 500;

/**
 * 正文保留上限（首尾法）：超长时保留开头一段 + 结尾一段，中间丢掉。
 * 开头固定 {@link HEAD_BYTES} 字节，结尾保留「总量 - 开头」那么多（只留最后一段），
 * 两者相加 = {@link BODY_TOTAL_BYTES}。开启「完整捕获」后不截断，全留。
 */
const HEAD_BYTES = 8 * 1024;
const BODY_TOTAL_BYTES = 24 * 1024;
const TAIL_BYTES = BODY_TOTAL_BYTES - HEAD_BYTES;

/** 压缩响应体：整段超过这个大小就不留着解压了（避免为解压攒一大块内存） */
const MAX_DECOMPRESS_BYTES = 1024 * 1024;

/** 这条请求从哪来：LLM 对话 / 模型配置探测 / 其它 */
export type TrafficKind = "llm" | "probe" | "http";

/**
 * 一段正文的保留结果（首尾法）。
 * 未截断时 `head` 即全文、`tail` 为空、`headBytes === totalBytes`；
 * 截断时 `headBytes + tailBytes < totalBytes`，中间省略的字节数 = totalBytes - headBytes - tailBytes。
 */
export interface BodyCapture {
    /** 首段文本（固定 HEAD_BYTES 字节；未截断时即全文） */
    head: string;
    /** 尾段文本（只留最后一段；未截断时为空串） */
    tail: string;
    /** 首段保留的字节数 */
    headBytes: number;
    /** 尾段保留的字节数（未截断为 0） */
    tailBytes: number;
    /** 正文完整字节数 */
    totalBytes: number;
    /** 是否被截断 */
    truncated: boolean;
}

export interface TrafficRecord {
    id: number;
    ts: number;
    kind: TrafficKind;
    /** 归属键（x-opencode-session）；模型配置探测 / 其它请求没有 → 空串 */
    session: string;
    taskUri: string | null;
    turnId: string | null;
    provider: string;
    model: string;
    baseUrl: string;
    method: string;
    /** 完整请求 URL（undici 事件里没有现成 url 字段，用 origin + path 拼） */
    url: string;
    host: string;
    path: string;
    attempt: number;
    maxRetries: number;
    status: number | null;
    ms: number;
    reqHeaders: Record<string, string>;
    reqBody: BodyCapture | null;
    resHeaders: Record<string, string>;
    resBody: BodyCapture | null;
    /** 未捕获响应正文时的说明（流式 / 成功未录制 / 过大未解压） */
    resNote: string | null;
    traceId: string | null;
    err: string | null;
    /** 该条记录落盘后的位置（随机读用）；写盘失败或未启用时为 null */
    log: LogLoc | null;
}

/** 一次运行的归属信息（发请求前登记，供反查） */
export interface RunMeta {
    session: string;
    taskUri: string;
    turnId: string;
    provider: string;
    model: string;
    baseUrl: string;
    maxRetries: number;
}

export interface TrafficSnapshot {
    /** 是否「完整捕获」（正文不截断）；默认 false */
    fullCapture: boolean;
    /** 内存里最多留多少条 */
    cap: number;
    total: number;
    /** 日志目录（相对 DIY_HOME），界面展示 / 将来清理用 */
    logDir: string;
    records: TrafficRecord[];
}

/** undici 事件里的 request 形状（只列我们用到的字段） */
interface UReq {
    method: string;
    origin: string;
    path: string;
    headers: Array<string | Uint8Array>;
}
interface URes {
    statusCode: number;
    headers: Array<string | Uint8Array>;
}

/** 一次往返的累积器（create 时建，trailers / error 时收口） */
interface Acc {
    rec: TrafficRecord;
    reqBody: BodyBuf;
    /** 响应正文累积器（收到响应头、知道 content-encoding 后才建） */
    resBody: BodyBuf | null;
    committed: boolean;
}

function toStr(v: unknown): string {
    if (typeof v === "string") return v;
    if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
    return v == null ? "" : String(v);
}

/** headers 两种形状都要吃：请求是 `[k,v,k,v…]` 数组，也可能已是对象 */
function headersToObject(h: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(h)) {
        for (let i = 0; i + 1 < h.length; i += 2) {
            const k = toStr(h[i]).toLowerCase();
            const v = toStr(h[i + 1]);
            out[k] = out[k] === undefined ? v : `${out[k]}, ${v}`;
        }
    } else if (h && typeof h === "object") {
        for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k.toLowerCase()] = toStr(v);
    }
    if (out["authorization"]) out["authorization"] = redact(out["authorization"]);
    return out;
}

/** `Bearer sk-…abcd` → `Bearer ****abcd`（只留尾 4 位） */
function redact(v: string): string {
    const tail = v.slice(-4);
    return `${v.split(/\s/)[0]} ****${tail}`;
}

/**
 * 响应体可能在传输层被压缩（content-encoding: br/gzip/deflate），undici 事件给的是**压缩后的
 * 原始字节**。按声明的编码解压；解不开就退回按文本读（宁可看到乱码也不丢这条记录）。
 */
function decodeBody(buf: Buffer, encoding: string): string {
    try {
        if (encoding.includes("br")) return brotliDecompressSync(buf).toString("utf8");
        if (encoding.includes("gzip")) return gunzipSync(buf).toString("utf8");
        if (encoding.includes("deflate")) return inflateSync(buf).toString("utf8");
    } catch {
        /* 编码声明与实际不符：退回原文 */
    }
    return buf.toString("utf8");
}

/**
 * 正文累积器：边收边留，内存有界。
 *
 * 默认（截断）只留「开头固定一段 + 结尾固定一段」，中间直接丢；再大的正文也只占
 * BODY_TOTAL_BYTES 左右。full = true（完整捕获）时不丢，全留。
 * 响应体若声明了 content-encoding（压缩），必须整段收到才能解压，所以这时按 full 收，
 * 但带上限 MAX_DECOMPRESS_BYTES：超过就不留了，免得为解压攒一大块内存。
 */
class BodyBuf {
    private headParts: Buffer[] = [];
    private headLen = 0;
    private tailParts: Buffer[] = [];
    private tailLen = 0;
    /** 收到的总字节数 */
    total = 0;
    /** full 模式下超过上限（压缩体）：正文没留住 */
    overLimit = false;
    constructor(
        private full: boolean,
        private limit = Number.POSITIVE_INFINITY,
    ) {}

    push(chunk: Buffer): void {
        this.total += chunk.length;
        if (this.full) {
            if (this.total <= this.limit) this.headParts.push(chunk);
            else this.overLimit = true;
            return;
        }
        // 先填满开头那段
        if (this.headLen < HEAD_BYTES) {
            const need = HEAD_BYTES - this.headLen;
            const take = chunk.length <= need ? chunk : chunk.subarray(0, need);
            this.headParts.push(take);
            this.headLen += take.length;
            if (chunk.length <= need) return;
            chunk = chunk.subarray(need);
        }
        // 其余进结尾那段，只留最近 TAIL_BYTES 字节
        this.tailParts.push(chunk);
        this.tailLen += chunk.length;
        while (this.tailLen > TAIL_BYTES) {
            const first = this.tailParts[0]!;
            const excess = this.tailLen - TAIL_BYTES;
            if (first.length <= excess) {
                this.tailParts.shift();
                this.tailLen -= first.length;
            } else {
                this.tailParts[0] = first.subarray(excess);
                this.tailLen -= excess;
            }
        }
    }

    /** 是否留住了完整正文 */
    private get complete(): boolean {
        return this.full ? !this.overLimit : this.total <= this.headLen + this.tailLen;
    }

    /** 收口成展示用的正文；encoding 非空时按声明解压（只对完整正文有意义） */
    capture(encoding: string): BodyCapture {
        if (this.complete) {
            const text = decodeBody(Buffer.concat(this.headParts), encoding);
            const n = Buffer.byteLength(text, "utf8");
            return { head: text, tail: "", headBytes: n, tailBytes: 0, totalBytes: n, truncated: false };
        }
        return {
            head: Buffer.concat(this.headParts).toString("utf8"),
            tail: Buffer.concat(this.tailParts).toString("utf8"),
            headBytes: this.headLen,
            tailBytes: this.tailLen,
            totalBytes: this.total,
            truncated: true,
        };
    }
}

function originOf(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return url;
    }
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** 落盘前把 `log` 摘掉（行里不需要记自己位置），其余原样存 */
function payloadOf(rec: TrafficRecord): Record<string, unknown> {
    const { log: _log, ...rest } = rec;
    return rest;
}

class Traffic {
    private seq = 0;
    private version = 0;
    private records: TrafficRecord[] = [];
    private fullCapture = false;
    private cap = CAP_DEFAULT;
    private inited = false;
    /** session → 本轮归属（发请求前登记；事件里按 session / 地址反查） */
    private runs = new Map<string, RunMeta>();
    /** 地址 origin → 归属来源（缺 `x-opencode-session` 头时的兜底：按地址匹配） */
    private originKind = new Map<string, { kind: TrafficKind; session: string; provider: string; model: string; baseUrl: string }>();
    /** 地址 origin → 最近的归属（用于展示 provider/model） */
    private originMeta = new Map<string, RunMeta>();
    /** session → 本轮请求序号（每次重试都是一次 HTTP 往返，天然逐次自增） */
    private attempts = new Map<string, number>();
    /** 进行中的往返：undici request 对象 → 累积器（同对象贯穿 create→trailers） */
    private accs = new WeakMap<object, Acc>();
    private waiters: Array<() => void> = [];

    /**
     * 订阅 undici 事件（幂等）。必须在任何请求前调用 —— 主进程启动处显式调一次，
     * noteRun 里再 lazy 兜底一次（CLI / serve 等多入口都覆盖）。
     */
    init(): void {
        if (this.inited) return;
        this.inited = true;
        subscribe(CH_CREATE, (msg) => this.guard(() => this.onCreate(msg as { request: UReq })));
        subscribe(CH_REQ_CHUNK, (msg) => this.guard(() => this.onReqChunk(msg as { request: UReq; chunk: Uint8Array })));
        subscribe(CH_HEADERS, (msg) => this.guard(() => this.onHeaders(msg as { request: UReq; response: URes })));
        subscribe(CH_RES_CHUNK, (msg) => this.guard(() => this.onResChunk(msg as { request: UReq; chunk: Uint8Array })));
        subscribe(CH_TRAILERS, (msg) => this.guard(() => this.commit((msg as { request: UReq }).request)));
        subscribe(CH_ERROR, (msg) => this.guard(() => this.onError(msg as { request: UReq; error: Error })));
    }

    /** 回调里绝不让异常冒泡进 undici 请求路径 */
    private guard(fn: () => void): void {
        try {
            fn();
        } catch {
            /* 观测失败不该影响业务请求：静默 */
        }
    }

    /** 发请求前登记：本轮归属 + 序号归零（LLM 对话调用） */
    noteRun(meta: RunMeta): void {
        this.init();
        this.runs.set(meta.session, meta);
        this.originMeta.set(originOf(meta.baseUrl), meta);
        this.originKind.set(originOf(meta.baseUrl), {
            kind: "llm",
            session: meta.session,
            provider: meta.provider,
            model: meta.model,
            baseUrl: meta.baseUrl,
        });
        this.attempts.set(meta.session, 0);
    }

    /**
     * 登记一个「探测地址」（如模型配置里点「测试」时拉 `{baseUrl}/models`）。
     * 这类请求没有任务归属，但归我们发起 → 记下来，标注来源，方便在流量页看到。
     */
    noteProbe(baseUrl: string): void {
        this.init();
        this.originKind.set(originOf(baseUrl), {
            kind: "probe",
            session: "",
            provider: "",
            model: "",
            baseUrl,
        });
    }

    isFullCapture(): boolean {
        return this.fullCapture;
    }

    /** 日志目录（相对 DIY_HOME） */
    logDir(): string {
        return LOG_DIR_REL;
    }

    /**
     * 按位置随机读一条落盘记录（界面「打开磁盘上的本条」用）。
     * 文件失效 / 版本不符 → 抛 TrafficLogError，界面直接显示原因。
     */
    readLog(loc: LogLoc): Record<string, unknown> {
        return readRecord(loc);
    }

    /** 现有日志文件清单（清理界面将来用） */
    listLogFiles(): string[] {
        return listFiles();
    }

    /** 日志目录绝对路径（将来打开目录用） */
    logDirAbs(): string {
        return absOf(LOG_DIR_REL);
    }

    /** 最近一次失败的记录 id（status>=400 或网络错）—— 错误块「打开那条请求」用 */
    latestFailure(session?: string): number | null {
        for (let i = this.records.length - 1; i >= 0; i--) {
            const r = this.records[i]!;
            if (session && r.session !== session) continue;
            if ((r.status != null && r.status >= 400) || r.err) return r.id;
        }
        return null;
    }

    private accOf(r: object): Acc | undefined {
        return this.accs.get(r);
    }

    private onCreate(msg: { request: UReq }): void {
        const r = msg.request;
        if (!r || typeof r !== "object") return;
        const headers = headersToObject(r.headers);
        const origin = r.origin;
        const session = headers["x-opencode-session"] || this.originKind.get(origin)?.session || "";
        const run = session ? this.runs.get(session) : undefined;
        const fallback = this.originKind.get(origin);
        // 归属优先：当前运行的 run → 地址登记的来源（探测/兜底）→ 其它
        const kind: TrafficKind = run ? "llm" : (fallback?.kind ?? "http");
        const meta = run ?? this.originMeta.get(origin);
        // 无任何线索的请求也记（流量页要能看到全部出站请求），只是没有任务归属
        const attempt = session ? (this.attempts.get(session) ?? 0) + 1 : 1;
        if (session) this.attempts.set(session, attempt);
        const url = `${r.origin}${r.path}`;
        const rec: TrafficRecord = {
            id: ++this.seq,
            ts: Date.now(),
            kind,
            session,
            taskUri: meta?.taskUri ?? null,
            turnId: meta?.turnId ?? null,
            provider: meta?.provider ?? fallback?.provider ?? "",
            model: meta?.model ?? fallback?.model ?? "",
            baseUrl: meta?.baseUrl ?? fallback?.baseUrl ?? "",
            method: (r.method ?? "GET").toUpperCase(),
            url,
            host: hostOf(url),
            path: r.path,
            attempt,
            maxRetries: meta?.maxRetries ?? 0,
            status: null,
            ms: 0,
            reqHeaders: headers,
            reqBody: null,
            resHeaders: {},
            resBody: null,
            resNote: null,
            traceId: null,
            err: null,
            log: null,
        };
        this.accs.set(r, { rec, reqBody: new BodyBuf(this.fullCapture), resBody: null, committed: false });
    }

    private onReqChunk(msg: { request: UReq; chunk: Uint8Array }): void {
        const acc = this.accOf(msg.request);
        // 复制一份：chunk 是底层复用/回收的字节，直接留引用会拿到后续内容
        if (acc && msg.chunk) acc.reqBody.push(Buffer.from(msg.chunk));
    }

    private onHeaders(msg: { request: UReq; response: URes }): void {
        const acc = this.accOf(msg.request);
        if (!acc) return;
        const res = msg.response;
        acc.rec.status = res.statusCode;
        acc.rec.resHeaders = headersToObject(res.headers);
        // 追责凭据：各网关叫法不同 —— commandcode.ai = x-trace-id，
        // opencode zen = x-opencode-log-id，通用 = x-request-id。取到哪个算哪个。
        const h = acc.rec.resHeaders;
        acc.rec.traceId =
            h["x-trace-id"] ??
            h["x-request-id"] ??
            h["x-opencode-log-id"] ??
            // 再退一步：任何形如 `*-trace-id` / `*-log-id` 的头（如 deepseek 的 x-ds-trace-id）
            (Object.entries(h).find(([k]) => /(^|-)trace[-_]?id$|(^|-)log[-_]?id$/.test(k))?.[1] ?? null);
        // 响应正文一律留（有界）。压缩体要整段收到才能解压，故按 full 收、带上限。
        const encoding = acc.rec.resHeaders["content-encoding"] ?? "";
        acc.resBody = new BodyBuf(
            encoding ? true : this.fullCapture,
            encoding ? MAX_DECOMPRESS_BYTES : Number.POSITIVE_INFINITY,
        );
    }

    private onResChunk(msg: { request: UReq; chunk: Uint8Array }): void {
        const acc = this.accOf(msg.request);
        if (acc?.resBody && msg.chunk) acc.resBody.push(Buffer.from(msg.chunk));
    }

    private onError(msg: { request: UReq; error: Error }): void {
        const acc = this.accOf(msg.request);
        if (!acc) return;
        acc.rec.err = msg.error instanceof Error ? msg.error.message : String(msg.error);
        this.finalize(acc);
    }

    /** trailers / error 都收口；WeakMap 的键仍在，用 committed 防重复 */
    private commit(req: object): void {
        const acc = this.accOf(req);
        if (acc) this.finalize(acc);
    }

    private finalize(acc: Acc): void {
        if (acc.committed) return;
        acc.committed = true;
        const rec = acc.rec;
        rec.ms = Date.now() - rec.ts;
        if (acc.reqBody.total > 0) {
            // 请求体不压缩（我们自己发的），直接按文本保留
            rec.reqBody = acc.reqBody.capture("");
        }
        const rb = acc.resBody;
        if (rb && rb.overLimit) {
            rec.resNote = `（响应体过大（${rb.total} 字节），未保留）`;
        } else if (rb && rb.total > 0) {
            rec.resBody = rb.capture(rec.resHeaders["content-encoding"] ?? "");
        }
        this.push(rec);
    }

    private push(rec: TrafficRecord): void {
        // 落盘（尽力而为：写失败不影响界面查看）
        try {
            rec.log = appendRecord(payloadOf(rec));
        } catch {
            rec.log = null;
        }
        this.records.push(rec);
        while (this.records.length > this.cap) this.records.shift();
        this.notify();
    }

    snapshot(): TrafficSnapshot {
        return {
            fullCapture: this.fullCapture,
            cap: this.cap,
            total: this.records.length,
            logDir: LOG_DIR_REL,
            records: [...this.records],
        };
    }

    clear(): void {
        this.records = [];
        this.notify();
    }

    /** 完整捕获：开 = 正文不再截断（默认关）。关掉不影响已经记下的条。 */
    setFullCapture(on: boolean): void {
        this.fullCapture = on;
        this.notify();
    }

    /** 内存保留条数上限 */
    setCap(n: number): void {
        this.cap = Math.max(1, Math.min(5000, Math.floor(n)));
        while (this.records.length > this.cap) this.records.shift();
        this.notify();
    }

    /** 事件流：每次记录/清空/开关变更推一次版本号（UI 收到后拉 snapshot） */
    async *events(): AsyncIterableIterator<{ version: number }> {
        let seen = this.version;
        for (;;) {
            if (this.version !== seen) {
                seen = this.version;
                yield { version: seen };
                continue;
            }
            await new Promise<void>((r) => this.waiters.push(r));
        }
    }

    private notify(): void {
        this.version++;
        const ws = this.waiters;
        this.waiters = [];
        for (const w of ws) w();
    }
}

/** 进程内单例（主进程 = 唯一写入方） */
export const traffic = new Traffic();
