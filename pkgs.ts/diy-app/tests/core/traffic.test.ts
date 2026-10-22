// tests/core/traffic.test.ts
// 流量观测（undici diagnostics_channel）的纯逻辑：记录形状、脱敏、上限裁剪、
// 常开上限、正文有界保留（首尾法）、归属反查、attempt 递增、错误体捕获、来源分类。
//
// 驱动方式：直接往 `node:diagnostics_channel` 上 publish 假事件 —— 与 undici 真实
// 收发的事件同形（见 core/traffic.ts 顶部注释），比真发便宜且可观（真发要 key、
// 要钱，且偶发 400 不可控）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { channel } from "node:diagnostics_channel";
import { traffic, TrafficLogError } from "../../src/main/core/traffic";

const RUN = {
    session: "ses_test",
    taskUri: "projects/1/tasks/2",
    turnId: "turn-1",
    provider: "custom:goat",
    model: "deepseek/deepseek-v4.1-flash",
    baseUrl: "https://api.example.com/provider/v1",
    maxRetries: 2,
};

/** 请求头数组形状：undici 里是 [k,v,k,v…] */
function headersArr(h: Record<string, string>): string[] {
    return Object.entries(h).flat();
}
function headersBufArr(h: Record<string, string>): Buffer[] {
    return Object.entries(h).flatMap(([k, v]) => [Buffer.from(k), Buffer.from(v)]);
}
const enc = (s: string) => new TextEncoder().encode(s);

interface FakeReq {
    method: string;
    origin: string;
    path: string;
    headers: string[];
}

function fireReq(opt?: { headers?: Record<string, string>; body?: string }): FakeReq {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-opencode-session": RUN.session,
        authorization: "Bearer sk-abcdefgh",
    };
    Object.assign(headers, opt?.headers ?? {});
    const req: FakeReq = {
        method: "POST",
        origin: "https://api.example.com",
        path: "/provider/v1/chat/completions",
        headers: headersArr(headers),
    };
    channel("undici:request:create").publish({ request: req });
    if (opt?.body !== undefined) channel("undici:request:bodyChunkSent").publish({ request: req, chunk: enc(opt.body) });
    return req;
}

function fireRes(req: FakeReq, status: number, headers: Record<string, string>, body?: string): void {
    channel("undici:request:headers").publish({ request: req, response: { statusCode: status, headers: headersBufArr(headers) } });
    if (body !== undefined) channel("undici:request:bodyChunkReceived").publish({ request: req, chunk: enc(body) });
    channel("undici:request:trailers").publish({ request: req, trailers: [] });
}

beforeEach(() => {
    traffic.clear();
    traffic.setFullCapture(false);
    traffic.setCap(20);
    traffic.noteRun(RUN); // 内含 init()：订阅通道
});

describe("traffic（undici diagnostics_channel）", () => {
    it("成功往返：status / traceId / 请求头（脱敏）/ 请求体，归属反查得到 task", () => {
        const req = fireReq({ body: JSON.stringify({ model: "x" }) });
        fireRes(req, 200, { "content-type": "text/event-stream", "x-trace-id": "trace-abc-123" });

        const { records } = traffic.snapshot();
        expect(records).toHaveLength(1);
        const r = records[0];
        expect(r.status).toBe(200);
        expect(r.traceId).toBe("trace-abc-123");
        expect(r.attempt).toBe(1);
        expect(r.taskUri).toBe(RUN.taskUri); // 靠 x-opencode-session 反查
        expect(r.turnId).toBe(RUN.turnId);
        expect(r.provider).toBe(RUN.provider);
        expect(r.path).toBe("/provider/v1/chat/completions");
        expect(r.url).toBe("https://api.example.com/provider/v1/chat/completions");
        expect(r.method).toBe("POST");
        expect(r.reqHeaders.authorization).toBe("Bearer ****efgh"); // 只留尾 4 位
        // 正文按「首尾法」保留：没超上限 → 全文在 head，未截断
        expect(JSON.parse(r.reqBody!.head)).toEqual({ model: "x" });
        expect(r.reqBody!.truncated).toBe(false);
        expect(r.reqBody!.headBytes).toBe(r.reqBody!.totalBytes);
    });

    it("脱敏：无 scheme 的裸凭据不得原样落盘（authorization / x-api-key / cookie 一律只留尾 4 位）", () => {
        const req = fireReq({
            headers: {
                // 无 scheme 的裸 key：早先实现会把整把 key 当「scheme」留下 → 明文落盘
                authorization: "sk-1234567890abcdef",
                "x-api-key": "abcdef1234567890",
                cookie: "session=deadbeefcafe",
            },
            body: "{}",
        });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const h = traffic.snapshot().records[0]!.reqHeaders;
        expect(h.authorization).toBe("****cdef");
        expect(h["x-api-key"]).toBe("****7890");
        expect(h.cookie).toBe("****cafe");
        // 明文一个都不许漏
        const all = JSON.stringify(h);
        expect(all).not.toContain("1234567890abcdef");
        expect(all).not.toContain("abcdef1234567890");
        expect(all).not.toContain("deadbeefcafe");
    });

    it("snapshot(withRecords:false)：只回状态，不带记录数组（事件流刷新用，省 IPC）", () => {
        const req = fireReq({ body: "{}" });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const light = traffic.snapshot(false);
        expect(light.records).toEqual([]);
        expect(light.total).toBe(1); // 总数照报
        expect(traffic.snapshot().records).toHaveLength(1); // 默认仍带记录
    });

    it("字节数：reqBytes / resBytes 记完整大小（不受首尾法截断影响）", () => {
        const body = "x".repeat(40 * 1024); // 40K > 24K → 必被截断
        const req = fireReq({ body });
        fireRes(req, 200, { "content-type": "application/json" }, body);

        const r = traffic.snapshot().records[0];
        expect(r.reqBody!.truncated).toBe(true);
        expect(r.resBody!.truncated).toBe(true);
        // 正文被截断了，但字节数仍是完整大小（表格「大小」列据此显示）
        expect(r.reqBytes).toBe(40 * 1024);
        expect(r.resBytes).toBe(40 * 1024);
    });

    it("400：记下上游错误体（扁平错误 + trace_id）", () => {
        const req = fireReq({ body: "{}" });
        fireRes(req, 400, { "content-type": "application/json" }, JSON.stringify({ message: "invalid request error trace_id: 1662a9a0", type: "invalid_request_error" }));

        const r = traffic.snapshot().records[0];
        expect(r.status).toBe(400);
        expect(JSON.parse(r.resBody!.head).type).toBe("invalid_request_error");
    });

    it("重试：同一轮内 attempt 逐次自增（ai-sdk 每次重试即一次 HTTP 往返）", () => {
        for (let i = 0; i < 2; i++) {
            const req = fireReq({ body: "{}" });
            fireRes(req, 429, { "content-type": "application/json" }, "{}");
        }
        expect(traffic.snapshot().records.map((r) => r.attempt)).toEqual([1, 2]);
    });

    it("★ 步归属（##409）：noteStep 后同一步的两次往返 = stepSeq 1 / attemptInStep 1,2（重试链可读）", () => {
        traffic.noteStep(RUN.session, RUN.turnId, 1);
        const a = fireReq({ body: "{}" });
        fireRes(a, 429, { "content-type": "application/json" }, "{}");
        const b = fireReq({ body: "{}" }); // SDK 重试：又一次 HTTP 往返，不再走 prepareStep
        fireRes(b, 200, { "content-type": "application/json" }, "{}");

        const recs = traffic.snapshot().records;
        expect(recs.map((r) => r.stepSeq)).toEqual([1, 1]);
        expect(recs.map((r) => r.attemptInStep)).toEqual([1, 2]); // 该步第 1 次 / 第 1 次重试
        expect(recs.map((r) => r.attempt)).toEqual([1, 2]); // 老字段仍在（兼容）
    });

    it("★ 步归属：下一步（noteStep 2）的 attemptInStep 从 1 重新起算，attempt 仍跨步累计", () => {
        traffic.noteStep(RUN.session, RUN.turnId, 1);
        const a = fireReq({ body: "{}" });
        fireRes(a, 200, { "content-type": "application/json" }, "{}");
        traffic.noteStep(RUN.session, RUN.turnId, 2);
        const b = fireReq({ body: "{}" });
        fireRes(b, 200, { "content-type": "application/json" }, "{}");

        const recs = traffic.snapshot().records;
        expect(recs.map((r) => [r.stepSeq, r.attemptInStep, r.attempt])).toEqual([
            [1, 1, 1],
            [2, 1, 2],
        ]);
    });

    it("步归属：没登记步（探测 / 摘要 / 老用法）→ stepSeq 与 attemptInStep 都 null，attempt 照旧自增", () => {
        const a = fireReq({ body: "{}" });
        fireRes(a, 200, { "content-type": "application/json" }, "{}");
        const b = fireReq({ body: "{}" });
        fireRes(b, 200, { "content-type": "application/json" }, "{}");
        const recs = traffic.snapshot().records;
        expect(recs.map((r) => r.stepSeq)).toEqual([null, null]);
        expect(recs.map((r) => r.attemptInStep)).toEqual([null, null]);
        expect(recs.map((r) => r.attempt)).toEqual([1, 2]);
    });

    it("步归属：登记的是**别的轮**的步（同 session 上叠了摘要之类）→ 不采信，留 null（宁缺勿错）", () => {
        traffic.noteStep("another-turn-session", "turn-other", 3); // 别的 session，无关
        traffic.noteStep(RUN.session, "turn-other", 3); // 同 session、别的轮
        traffic.noteRun({ ...RUN, turnId: "turn-2" }); // 本次运行登记的是 turn-2
        const req = fireReq({ body: "{}" });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const r = traffic.snapshot().records[0]!;
        expect(r.turnId).toBe("turn-2");
        expect(r.stepSeq).toBeNull();
        expect(r.attemptInStep).toBeNull();
    });

    it("网络异常：status 落 null 并记 err（error 事件收口）", () => {
        const req = fireReq({ body: "{}" });
        channel("undici:request:error").publish({ request: req, error: new Error("connect ETIMEDOUT") });
        const r = traffic.snapshot().records[0];
        expect(r.status).toBeNull();
        expect(r.err).toContain("ETIMEDOUT");
    });

    it("★ 超时不可复盘的现场（##409）：卡在连接的首试 + 成功重试 → 各自 ms、最后一次成败 / 卡在哪都读得出", () => {
        // 341s 那类记录：create 之后很久才收到 error（连接超时），响应头从未到达
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            traffic.noteStep(RUN.session, RUN.turnId, 8);
            const bad = fireReq({ body: "{}" });
            vi.setSystemTime(1_000_000 + 341_145);
            channel("undici:request:error").publish({
                request: bad,
                error: new Error("Connect Timeout Error (attempted address: api.example.com:443, timeout: 10000ms)"),
            });

            vi.setSystemTime(1_000_000 + 342_000);
            const ok = fireReq({ body: "{}" });
            vi.setSystemTime(1_000_000 + 342_000 + 200);
            channel("undici:request:headers").publish({
                request: ok,
                response: { statusCode: 200, headers: headersBufArr({ "content-type": "application/json" }) },
            });
            vi.setSystemTime(1_000_000 + 342_000 + 6644);
            channel("undici:request:trailers").publish({ request: ok, trailers: [] });

            const recs = traffic.snapshot().records;
            // 两条各自计时（从不合并成一个数）
            expect(recs[0]!.ms).toBe(341_145);
            expect(recs[1]!.ms).toBe(6644);
            // 同一步的两次往返：第 1 次失败、第 2 次成功 —— 「试了几次 / 最后一次成没成」有答案
            expect(recs.map((r) => [r.stepSeq, r.attemptInStep])).toEqual([
                [8, 1],
                [8, 2],
            ]);
            // 卡在哪：首试没有响应头（ttfbMs=null）⇒ 时间全花在连接阶段；重试有响应头
            expect(recs[0]!.ttfbMs).toBeNull();
            expect(recs[1]!.ttfbMs).toBe(200);
            expect(recs[0]!.err).toContain("Connect Timeout");
        } finally {
            vi.useRealTimers();
        }
    });

    it("ttfbMs：收到响应头的时刻单独记 → 把「连接 + 等首字节」与「下载」分开", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(5_000_000);
            const req = fireReq({ body: "{}" });
            vi.setSystemTime(5_000_000 + 1200);
            channel("undici:request:headers").publish({
                request: req,
                response: { statusCode: 200, headers: headersBufArr({ "content-type": "application/json" }) },
            });
            vi.setSystemTime(5_000_000 + 8000);
            channel("undici:request:bodyChunkReceived").publish({ request: req, chunk: enc("{}") });
            channel("undici:request:trailers").publish({ request: req, trailers: [] });

            const r = traffic.snapshot().records[0]!;
            expect(r.ms).toBe(8000);
            expect(r.ttfbMs).toBe(1200); // 连接 + 排队 + 上游首字节
        } finally {
            vi.useRealTimers();
        }
    });

    it("落盘：新字段（stepSeq / attemptInStep / ttfbMs）一并写进 JSONL —— 事后回看也在", () => {
        traffic.noteStep(RUN.session, RUN.turnId, 2);
        const req = fireReq({ body: "{}" });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const r = traffic.snapshot().records[0]!;
        const back = traffic.readLog(r.log!) as Record<string, unknown>;
        expect(back.stepSeq).toBe(2);
        expect(back.attemptInStep).toBe(1);
        expect(back.ttfbMs).not.toBeNull();
    });

    it("无归属（无 x-opencode-session 且 origin 未登记）：仍记录为其它来源", () => {
        const req: FakeReq = {
            method: "GET",
            origin: "https://other.example.net",
            path: "/ping",
            headers: headersArr({ "content-type": "text/plain" }),
        };
        channel("undici:request:create").publish({ request: req });
        channel("undici:request:trailers").publish({ request: req, trailers: [] });
        const r = traffic.snapshot().records[0];
        expect(r.kind).toBe("http");
        expect(r.taskUri).toBeNull();
        expect(r.host).toBe("other.example.net");
    });

    it("noteProbe：登记探测地址后，该地址的请求归类为 probe", () => {
        traffic.noteProbe("https://probe.example.com/v1");
        const req: FakeReq = {
            method: "GET",
            origin: "https://probe.example.com",
            path: "/v1/models",
            headers: headersArr({ "content-type": "application/json" }),
        };
        channel("undici:request:create").publish({ request: req });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const r = traffic.snapshot().records[0];
        expect(r.kind).toBe("probe");
        expect(r.method).toBe("GET");
    });

    it("latestFailure：返回最近一次失败记录 id（可按 session 过滤）", () => {
        const ok = fireReq({ body: "{}" });
        fireRes(ok, 200, { "content-type": "application/json" }, "{}");
        const bad = fireReq({ body: "{}" });
        fireRes(bad, 400, { "content-type": "application/json" }, "{}");
        expect(traffic.latestFailure()).toBe(traffic.snapshot().records[1].id);
        expect(traffic.latestFailure(RUN.session)).toBe(traffic.snapshot().records[1].id);
        expect(traffic.latestFailure("nope")).toBeNull();
    });

    it("origin 兜底归属：缺 x-opencode-session 但 origin 命中已登记 baseUrl → 仍记", () => {
        const req: FakeReq = {
            method: "POST",
            origin: "https://api.example.com",
            path: "/provider/v1/chat/completions",
            headers: headersArr({ "content-type": "application/json" }),
        };
        channel("undici:request:create").publish({ request: req });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const r = traffic.snapshot().records[0];
        expect(r.taskUri).toBe(RUN.taskUri);
        expect(r.session).toBe(RUN.session);
    });

    it("上限：超过 cap 挤掉最旧的", () => {
        for (let i = 0; i < 25; i++) {
            const req = fireReq({ body: JSON.stringify({ model: `m${i}` }) });
            fireRes(req, 200, { "content-type": "application/json" }, "{}");
        }
        const { records } = traffic.snapshot();
        expect(records).toHaveLength(20);
        expect(JSON.parse(records[0].reqBody!.head).model).toBe("m5"); // m0..m4 被挤掉
    });

    it("完整捕获：成功响应体全留 → 25 条（上限内）都在", () => {
        traffic.setFullCapture(true);
        traffic.setCap(500);
        for (let i = 0; i < 25; i++) {
            const req = fireReq({ body: "{}" });
            fireRes(req, 200, { "content-type": "application/json" }, JSON.stringify({ n: i }));
        }
        const snap = traffic.snapshot();
        expect(snap).toMatchObject({ fullCapture: true, cap: 500 });
        expect(snap.records).toHaveLength(25);
        expect(JSON.parse(snap.records[24].resBody!.head)).toEqual({ n: 24 });
    });

    it("常开：成功流式响应的正文也捕获（默认截断模式下同样有界保留）", () => {
        const req = fireReq({ body: "{}" });
        fireRes(req, 200, { "content-type": "text/event-stream" }, "data: hello\n\n");
        const r = traffic.snapshot().records[0];
        expect(r.resBody?.head).toContain("data: hello");
        expect(r.resBody?.truncated).toBe(false);
    });

    it("traceId fallback：x-trace-id 缺省时退到 x-opencode-log-id", () => {
        const req = fireReq({ body: "{}" });
        fireRes(req, 200, { "content-type": "application/json", "x-opencode-log-id": "log-9" }, "{}");
        expect(traffic.snapshot().records[0].traceId).toBe("log-9");
    });

    it("首尾法截断：超 24K 正文保头 8K + 尾 16K，中间丢，记录首/尾/总字节", () => {
        const big = "x".repeat(40000);
        const req = fireReq({ body: JSON.stringify({ model: "m", pad: big }) });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const b = traffic.snapshot().records[0].reqBody!;
        expect(b.truncated).toBe(true);
        expect(b.headBytes).toBe(8 * 1024);
        expect(b.tailBytes).toBe(16 * 1024);
        expect(b.totalBytes).toBeGreaterThan(24 * 1024);
        expect(b.head.startsWith('{"model":"m","pad":"xxx')).toBe(true);
        expect(b.tail.endsWith('xxx"}')).toBe(true);
        // 首尾相接 + 中间省略 = 总长
        expect(b.headBytes + b.tailBytes).toBeLessThan(b.totalBytes);
    });

    it("常开：大响应体分块到达也按首尾法有界保留（头 8K + 尾 16K）", () => {
        const req = fireReq({ body: "{}" });
        channel("undici:request:headers").publish({
            request: req,
            response: { statusCode: 200, headers: headersBufArr({ "content-type": "application/json" }) },
        });
        const chunk = "y".repeat(1024);
        for (let i = 0; i < 40; i++) channel("undici:request:bodyChunkReceived").publish({ request: req, chunk: enc(chunk) });
        channel("undici:request:trailers").publish({ request: req, trailers: [] });
        const b = traffic.snapshot().records[0].resBody!;
        expect(b.truncated).toBe(true);
        expect(b.headBytes).toBe(8 * 1024);
        expect(b.tailBytes).toBe(16 * 1024);
        expect(b.totalBytes).toBe(40 * 1024);
        expect(b.head).toBe("y".repeat(8 * 1024));
        expect(b.tail).toBe("y".repeat(16 * 1024));
    });

    it("落盘：每条记录带文件位置，可按位置随机读回", () => {
        const req = fireReq({ body: JSON.stringify({ model: "x" }) });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const r = traffic.snapshot().records[0];
        expect(r.log).not.toBeNull();
        expect(r.log!.file).toMatch(/^log\/network\/\d{4}-\d{2}-\d{2}\.jsonl$/);
        expect(r.log!.len).toBeGreaterThan(0);
        const back = traffic.readLog(r.log!) as { url: string; status: number };
        expect(back.url).toBe(r.url);
        expect(back.status).toBe(200);
    });

    it("读取失效：文件不存在 → 抛 TrafficLogError（界面据此提示）", () => {
        expect(() =>
            traffic.readLog({ file: "log/network/1999-01-01.jsonl", offset: 0, len: 10 }),
        ).toThrow(TrafficLogError);
    });

    it("首尾法截断：多字节字符边界不切出半个字（无替换字符）", () => {
        const big = "中".repeat(30000); // 每个 3 字节，超 24K
        const req = fireReq({ body: JSON.stringify({ pad: big }) });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const b = traffic.snapshot().records[0].reqBody!;
        expect(b.truncated).toBe(true);
        expect(b.head.includes("\uFFFD")).toBe(false);
        expect(b.tail.includes("\uFFFD")).toBe(false);
    });

    it("读取失效：位置越界 → 抛 TrafficLogError", () => {
        const req = fireReq({ body: "{}" });
        fireRes(req, 200, { "content-type": "application/json" }, "{}");
        const loc = traffic.snapshot().records[0].log!;
        expect(() => traffic.readLog({ file: loc.file, offset: loc.offset + 10_000_000, len: 10 })).toThrow(
            TrafficLogError,
        );
    });
});
