/**
 * LLM 流量观测 —— 内存里留住「实际发出的 HTTP 请求 / 响应」，供 UI 当场追因。
 *
 * 为什么要有它：上游偶发 400（`trace_id: …`）只透传一行原文，provider / model / attempt /
 * 真实 wire 上的 body 全看不到 → 用户只能来问「谁的错」。本模块把每次 LLM HTTP 往返
 * 原样记下，UI 面板点开就能看：谁发的、发了什么、上游回了什么、第几次尝试。
 *
 * ## 拦截方式：undici diagnostics_channel（**不是**包 fetch）
 *
 * Node 内置 fetch（Electron main 的 `globalThis.fetch`）底层是 undici，它会往
 * `node:diagnostics_channel` 上 publish 这些通道（Node 24 实测）：
 *
 *   undici:request:create           {request}          method / origin / path / headers（数组）
 *   undici:request:bodyChunkSent    {request, chunk}   请求体分块（Uint8Array）
 *   undici:request:bodySent         {request}
 *   undici:request:headers          {request, response} statusCode / headers（Buffer 数组）
 *   undici:request:bodyChunkReceived{request, chunk}   响应体分块（Buffer；SSE 逐块）
 *   undici:request:trailers         {request, trailers}
 *   undici:request:error            {request, error}
 *
 * 为什么纯观察者比「包 `globalThis.fetch`」好（改前先读）：
 *  - 包 fetch 必须换 Response 实例 → 丢 `url`/`redirected`、brand check 失真、abort 透传要自己接；
 *    而 ai-sdk 自己也包 fetch 做重试 → 套娃难排查。
 *  - diagnostics 不碰流、不改时序，拿的是 undici 层**真实字节**（请求体 + 响应体都有）。
 *
 * ## 三条硬约束（设计决定，改前先读）
 *  1. **不落盘** —— 纯内存环形，进程重启即空。这是「当下调试」能力，不是审计日志。
 *  2. **常开保底环** —— 偶发 0.67% 崩在你没录制的时候，所以最近 N 条永远留着兜底；
 *     「录制」只是把上限放大 + 不截断（Chrome DevTools 那种「点开才有」只作增强）。
 *  3. **回调在请求同步路径上** —— subscribe 回调由 undici 在收发字节时**同步**调用，
 *     因此 handler 只做「copy 字节 + 计数」，绝不 await、绝不抛错（抛出去会污染请求链路）。
 *
 * 归属：请求里的 `x-opencode-session`（我们自己发的）反查 task/turn；缺该头时退到
 * 「origin 命中已登记 run 的 baseUrl」兜底。不依赖 AsyncLocalStorage。**无归属的请求不记**
 * （这样进程内其它 fetch 不会被误收）。
 */

import { subscribe } from "node:diagnostics_channel";

const CH_CREATE = "undici:request:create";
const CH_REQ_CHUNK = "undici:request:bodyChunkSent";
const CH_HEADERS = "undici:request:headers";
const CH_RES_CHUNK = "undici:request:bodyChunkReceived";
const CH_TRAILERS = "undici:request:trailers";
const CH_ERROR = "undici:request:error";

const KEEP_LAST_DEFAULT = 20;
const REC_CAP_DEFAULT = 500;
/** 单条请求/响应体截断上限（保底环；录制模式不截断） */
const BODY_LIMIT = 256 * 1024;
const STREAM_NOTE = "（流式响应，非录制模式不捕获正文）";

export interface TrafficRecord {
    id: number;
    ts: number;
    session: string;
    taskUri: string | null;
    turnId: string | null;
    provider: string;
    model: string;
    baseUrl: string;
    method: string;
    /** 完整请求 URL（origin + path：undici 事件里没有现成 url 字段） */
    url: string;
    path: string;
    attempt: number;
    maxRetries: number;
    status: number | null;
    ms: number;
    reqHeaders: Record<string, string>;
    reqBody: unknown;
    resHeaders: Record<string, string>;
    resBody: unknown;
    traceId: string | null;
    err: string | null;
}

/** 一次运行的归属信息（streamText 前登记，供反查） */
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
    recording: boolean;
    cap: number;
    keepLast: number;
    total: number;
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

/** 一次往返的累积器（在 create 时建，trailers / error 时收口） */
interface Acc {
    rec: TrafficRecord;
    reqChunks: Buffer[];
    resChunks: Buffer[];
    captureRes: boolean;
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

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function clip(v: unknown, limit: number): unknown {
    if (v == null) return v;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s == null || s.length <= limit) return v;
    return `${s.slice(0, limit)}\n…(截断，共 ${s.length} 字符)`;
}

function originOf(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return url;
    }
}

class LlmTraffic {
    private seq = 0;
    private version = 0;
    private records: TrafficRecord[] = [];
    private recording = false;
    private recCap = REC_CAP_DEFAULT;
    private keepLast = KEEP_LAST_DEFAULT;
    private inited = false;
    /** session → 本轮归属（streamText 前登记；事件里按 session / origin 反查） */
    private runs = new Map<string, RunMeta>();
    /** origin → session（缺 `x-opencode-session` 头时的兜底归属） */
    private originSession = new Map<string, string>();
    /** session → 本轮请求序号（ai-sdk 每次重试即一次 HTTP 往返，天然逐次自增） */
    private attempts = new Map<string, number>();
    /** 进行中的往返：undici request 对象 → 累积器（同对象贯穿 create→trailers） */
    private accs = new WeakMap<object, Acc>();
    private waiters: Array<() => void> = [];

    /**
     * 订阅 undici 通道（幂等）。必须在任何 LLM 请求前调用 —— 主进程启动处显式调一次，
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

    /** streamText 之前登记：本轮归属 + attempt 归零 */
    noteRun(meta: RunMeta): void {
        this.init();
        this.runs.set(meta.session, meta);
        this.attempts.set(meta.session, 0);
        this.originSession.set(originOf(meta.baseUrl), meta.session);
    }

    isRecording(): boolean {
        return this.recording;
    }

    private accOf(r: object): Acc | undefined {
        return this.accs.get(r);
    }

    private onCreate(msg: { request: UReq }): void {
        const r = msg.request;
        if (!r || typeof r !== "object") return;
        const headers = headersToObject(r.headers);
        const session = headers["x-opencode-session"] || this.originSession.get(r.origin) || "";
        const meta = session ? this.runs.get(session) : undefined;
        if (!meta) return; // 无归属 → 非 LLM 请求，不记（进程内其它 fetch 不误收）
        const attempt = (this.attempts.get(session) ?? 0) + 1;
        this.attempts.set(session, attempt);
        const url = `${r.origin}${r.path}`;
        const rec: TrafficRecord = {
            id: ++this.seq,
            ts: Date.now(),
            session,
            taskUri: meta.taskUri,
            turnId: meta.turnId,
            provider: meta.provider,
            model: meta.model,
            baseUrl: meta.baseUrl,
            method: (r.method ?? "GET").toUpperCase(),
            url,
            path: r.path,
            attempt,
            maxRetries: meta.maxRetries,
            status: null,
            ms: 0,
            reqHeaders: headers,
            reqBody: null,
            resHeaders: {},
            resBody: null,
            traceId: null,
            err: null,
        };
        this.accs.set(r, { rec, reqChunks: [], resChunks: [], captureRes: false, committed: false });
    }

    private onReqChunk(msg: { request: UReq; chunk: Uint8Array }): void {
        const acc = this.accOf(msg.request);
        // copy：chunk 是引用，Buffer 可能复用/回收
        if (acc && msg.chunk) acc.reqChunks.push(Buffer.from(msg.chunk));
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
        acc.rec.traceId = h["x-trace-id"] ?? h["x-request-id"] ?? h["x-opencode-log-id"] ?? null;
        // 失败体一定留；成功体仅录制模式留（其余记一行说明，省内存）
        acc.captureRes = res.statusCode >= 400 || this.recording;
    }

    private onResChunk(msg: { request: UReq; chunk: Uint8Array }): void {
        const acc = this.accOf(msg.request);
        if (acc && acc.captureRes && msg.chunk) acc.resChunks.push(Buffer.from(msg.chunk));
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
        if (acc.reqChunks.length) rec.reqBody = safeJson(Buffer.concat(acc.reqChunks).toString("utf8"));
        if (acc.captureRes) {
            rec.resBody = acc.resChunks.length ? safeJson(Buffer.concat(acc.resChunks).toString("utf8")) : null;
        } else if ((rec.resHeaders["content-type"] ?? "").includes("text/event-stream")) {
            rec.resBody = STREAM_NOTE;
        } else if (rec.status != null) {
            rec.resBody = "（非录制模式不捕获成功响应体）";
        }
        this.push(rec);
    }

    private push(rec: TrafficRecord): void {
        const limit = this.recording ? Infinity : BODY_LIMIT;
        rec.reqBody = clip(rec.reqBody, limit);
        rec.resBody = clip(rec.resBody, limit);
        this.records.push(rec);
        const cap = this.recording ? this.recCap : this.keepLast;
        while (this.records.length > cap) this.records.shift();
        this.notify();
    }

    snapshot(): TrafficSnapshot {
        return {
            recording: this.recording,
            cap: this.recording ? this.recCap : this.keepLast,
            keepLast: this.keepLast,
            total: this.records.length,
            records: [...this.records],
        };
    }

    clear(): void {
        this.records = [];
        this.notify();
    }

    setRecording(on: boolean): void {
        this.recording = on;
        this.notify();
    }

    setCap(n: number, which: "keepLast" | "recCap"): void {
        const v = Math.max(1, Math.min(5000, Math.floor(n)));
        if (which === "keepLast") this.keepLast = v;
        else this.recCap = v;
        const cap = this.recording ? this.recCap : this.keepLast;
        while (this.records.length > cap) this.records.shift();
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
export const llmTraffic = new LlmTraffic();
