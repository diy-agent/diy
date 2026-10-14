/**
 * 流量观测 —— 把主进程实际发出去的 HTTP 请求 / 响应留一份，供界面查看。
 *
 * 为什么要有它：出问题时用户只看到一行错误（比如上游偶发 400 只回一句带 trace_id 的话），
 * 却看不到是哪个地址、发了什么、上游回了什么。这里把每一次请求原样记下，界面点开就能看。
 *
 * ## 怎么拿到的：订阅 Node 的 undici 事件（不改 fetch）
 *
 * 主进程里 `fetch` 底层是 Node 的 undici，它每发一次请求都会往 `node:diagnostics_channel`
 * 广播事件。我们只是「旁听」这些广播：请求方法 / 地址 / 头 / body、响应状态 / 头 / body
 * 都能拿到，而且不碰数据流、不改时序，对业务完全无感（比替换 fetch 干净得多）。
 *
 * ## 三条设计决定（改前先读）
 *  1. **不做存储** —— 只在内存里留最近若干条，进程重启就没了。这是「当下排查」用的，
 *     不是审计日志（要留档另说）。
 *  2. **一直开着** —— 问题什么时候出现不可预期（比如偶发 0.67% 的失败），所以最近若干条
 *     始终留着兜底；「录制」只是把上限放大、并且不再截断内容，方便主动抓包时看全。
 *  3. **回调在请求的同步路径上** —— 事件回调是被同步调用的，所以这里只做「复制字节 + 计数」，
 *     绝不 await、绝不抛错（抛出去会连累正常请求）。
 *
 * 归属：优先看请求头 `x-opencode-session`（我们自己发的 LLM 请求带），反查是哪个任务 / 轮次；
 * 没有该头时，按「同一个地址」兜底匹配（同一个 provider 的地址只对应一个运行中的任务）。
 * 其它走 undici 的请求（比如模型配置里的「测试」按钮拉 /models）也会被记下，归属标注为对应
 * 来源（见 noteProbe）。
 */

import { subscribe } from "node:diagnostics_channel";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const CH_CREATE = "undici:request:create";
const CH_REQ_CHUNK = "undici:request:bodyChunkSent";
const CH_HEADERS = "undici:request:headers";
const CH_RES_CHUNK = "undici:request:bodyChunkReceived";
const CH_TRAILERS = "undici:request:trailers";
const CH_ERROR = "undici:request:error";

const KEEP_LAST_DEFAULT = 20;
const REC_CAP_DEFAULT = 500;
/** 单条请求/响应体截断上限（普通模式；录制模式不截断） */
const BODY_LIMIT = 256 * 1024;
const STREAM_NOTE = "（流式响应，普通模式不保存正文；开「录制」可看全文）";
const UNCAPTURED_NOTE = "（普通模式不保存成功响应正文；开「录制」可看全文）";

/** 这条请求从哪来：LLM 对话 / 模型配置探测 / 其它 */
export type TrafficKind = "llm" | "probe" | "http";

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
    reqBody: unknown;
    resHeaders: Record<string, string>;
    resBody: unknown;
    traceId: string | null;
    err: string | null;
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

/** 一次往返的累积器（create 时建，trailers / error 时收口） */
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

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

class Traffic {
    private seq = 0;
    private version = 0;
    private records: TrafficRecord[] = [];
    private recording = false;
    private recCap = REC_CAP_DEFAULT;
    private keepLast = KEEP_LAST_DEFAULT;
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

    isRecording(): boolean {
        return this.recording;
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
            traceId: null,
            err: null,
        };
        this.accs.set(r, { rec, reqChunks: [], resChunks: [], captureRes: false, committed: false });
    }

    private onReqChunk(msg: { request: UReq; chunk: Uint8Array }): void {
        const acc = this.accOf(msg.request);
        // 复制一份：chunk 是底层复用/回收的字节，直接留引用会拿到后续内容
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
        acc.rec.traceId =
            h["x-trace-id"] ??
            h["x-request-id"] ??
            h["x-opencode-log-id"] ??
            // 再退一步：任何形如 `*-trace-id` / `*-log-id` 的头（如 deepseek 的 x-ds-trace-id）
            (Object.entries(h).find(([k]) => /(^|-)trace[-_]?id$|(^|-)log[-_]?id$/.test(k))?.[1] ?? null);
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
            rec.resBody = acc.resChunks.length
                ? safeJson(decodeBody(Buffer.concat(acc.resChunks), rec.resHeaders["content-encoding"] ?? ""))
                : null;
        } else if ((rec.resHeaders["content-type"] ?? "").includes("text/event-stream")) {
            rec.resBody = STREAM_NOTE;
        } else if (rec.status != null) {
            rec.resBody = UNCAPTURED_NOTE;
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
export const traffic = new Traffic();
