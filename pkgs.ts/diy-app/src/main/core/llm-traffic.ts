/**
 * LLM 流量 tap —— 内存里留住「实际发出的 HTTP 请求 / 响应」，供 UI 当场追因。
 *
 * 为什么要有它：上游偶发 400（`trace_id: …`）只透传一行原文，provider / model / attempt /
 * 真实 wire 上的 body 全看不到 → 用户只能来问「谁的错」。本模块把每次 fetch 调用
 * （= 一次 LLM HTTP 往返，重试即再来一次）原样记下，UI 面板点开就能看。
 *
 * 三条硬约束（设计决定，改前先读）：
 *  1. **不落盘** —— 纯内存环形，进程重启即空。这是「当下调试」能力，不是审计日志；
 *     要长期留就该另立（届时先想清楚 key/token 的隐私面）。
 *  2. **常开保底环** —— 偶发 0.67% 崩在你没录制的时候，所以最近 N 条永远留着兜底；
 *     「录制」只是把上限放大 + 不截断（Chrome DevTools 那种「点开才有」只作增强）。
 *  3. **敏感头脱敏** —— `authorization` 只留尾 4 位。
 *
 * 归属：请求里带 `x-opencode-session`（我们自己发的，文件有 sessionIdOf 的反向注册表），
 * 据此把记录挂回 task/turn —— 不依赖 AsyncLocalStorage，也不给 provider 缓存加 task 维度。
 */

const KEEP_LAST_DEFAULT = 20;
const REC_CAP_DEFAULT = 500;
/** 单条请求/响应体截断上限（保底环；录制模式不截断） */
const BODY_LIMIT = 256 * 1024;
const STREAM_NOTE = "（流式响应，未捕获正文）";

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
    /** 完整请求 URL（别用 baseUrl+path 拼：baseUrl 自带路径前缀，会重复） */
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

/** 一次运行的归属信息（streamText 前登记，供 tap 反查） */
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

function headersToObject(h: HeadersInit | undefined | null): Record<string, string> {
    const out: Record<string, string> = {};
    if (!h) return out;
    if (h instanceof Headers) {
        h.forEach((v, k) => (out[k.toLowerCase()] = v));
    } else if (Array.isArray(h)) {
        for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
    } else {
        for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
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

class LlmTraffic {
    private seq = 0;
    private version = 0;
    private records: TrafficRecord[] = [];
    private recording = false;
    private recCap = REC_CAP_DEFAULT;
    private keepLast = KEEP_LAST_DEFAULT;
    /** session → 本轮归属（streamText 前登记；tap 按请求头里的 session 反查） */
    private runs = new Map<string, RunMeta>();
    /** session → 本轮的请求序号（ai-sdk 每次重试即一次 fetch，天然逐次自增） */
    private attempts = new Map<string, number>();
    private waiters: Array<() => void> = [];

    /** streamText 之前登记：本轮归属 + attempt 归零 */
    noteRun(meta: RunMeta): void {
        this.runs.set(meta.session, meta);
        this.attempts.set(meta.session, 0);
    }

    isRecording(): boolean {
        return this.recording;
    }

    /** tap fetch：包住真实 fetch，记一条再原样返回 */
    tap(): typeof fetch {
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const t0 = Date.now();
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const method = (init?.method ?? "GET").toUpperCase();
            const reqHeaders = headersToObject(init?.headers);
            const session = reqHeaders["x-opencode-session"] ?? "";
            const meta = session ? this.runs.get(session) : undefined;
            const attempt = (this.attempts.get(session) ?? 0) + 1;
            if (session) this.attempts.set(session, attempt);
            const raw = init?.body;
            const rec: TrafficRecord = {
                id: ++this.seq,
                ts: t0,
                session,
                taskUri: meta?.taskUri ?? null,
                turnId: meta?.turnId ?? null,
                provider: meta?.provider ?? "",
                model: meta?.model ?? "",
                baseUrl: meta?.baseUrl ?? new URL(url).origin,
                method,
                url,
                path: (() => {
                    try {
                        return new URL(url).pathname;
                    } catch {
                        return url;
                    }
                })(),
                attempt,
                maxRetries: meta?.maxRetries ?? 0,
                status: null,
                ms: 0,
                reqHeaders,
                reqBody: typeof raw === "string" ? safeJson(raw) : raw == null ? null : `${raw}`,
                resHeaders: {},
                resBody: null,
                traceId: null,
                err: null,
            };
            try {
                const res = await fetch(input as RequestInfo, init);
                rec.status = res.status;
                rec.ms = Date.now() - t0;
                rec.resHeaders = headersToObject(res.headers);
                // 追责凭据：各网关叫法不同 —— commandcode.ai = x-trace-id，
                // opencode zen = x-opencode-log-id，通用 = x-request-id。取到哪个算哪个。
                rec.traceId =
                    res.headers.get("x-trace-id") ??
                    res.headers.get("x-request-id") ??
                    res.headers.get("x-opencode-log-id") ??
                    null;
                const ct = res.headers.get("content-type") ?? "";
                const streaming = ct.includes("text/event-stream");
                if (res.status >= 400) {
                    // 失败体一般很小（扁平错误 JSON），clone 读全量不影响原流
                    try {
                        rec.resBody = safeJson(await res.clone().text());
                    } catch {
                        rec.resBody = null;
                    }
                } else if (streaming) {
                    rec.resBody = STREAM_NOTE;
                } else if (this.recording) {
                    try {
                        rec.resBody = safeJson(await res.clone().text());
                    } catch {
                        rec.resBody = null;
                    }
                } else {
                    rec.resBody = "（非录制模式不捕获成功响应体）";
                }
                this.push(rec);
                return res;
            } catch (e) {
                rec.ms = Date.now() - t0;
                rec.err = e instanceof Error ? e.message : String(e);
                this.push(rec);
                throw e;
            }
        };
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
