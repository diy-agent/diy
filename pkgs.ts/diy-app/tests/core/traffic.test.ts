// tests/core/traffic.test.ts
// 流量观测（undici diagnostics_channel）的纯逻辑：记录形状、脱敏、上限裁剪、
// 常开上限、正文有界保留（首尾法）、归属反查、attempt 递增、错误体捕获、来源分类。
//
// 驱动方式：直接往 `node:diagnostics_channel` 上 publish 假事件 —— 与 undici 真实
// 收发的事件同形（见 core/traffic.ts 顶部注释），比真发便宜且可观（真发要 key、
// 要钱，且偶发 400 不可控）。
import { describe, it, expect, beforeEach } from "vitest";
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
    const req: FakeReq = {
        method: "POST",
        origin: "https://api.example.com",
        path: "/provider/v1/chat/completions",
        headers: headersArr({
            "content-type": "application/json",
            "x-opencode-session": RUN.session,
            authorization: "Bearer sk-abcdefgh",
            ...(opt?.headers ?? {}),
        }),
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

    it("网络异常：status 落 null 并记 err（error 事件收口）", () => {
        const req = fireReq({ body: "{}" });
        channel("undici:request:error").publish({ request: req, error: new Error("connect ETIMEDOUT") });
        const r = traffic.snapshot().records[0];
        expect(r.status).toBeNull();
        expect(r.err).toContain("ETIMEDOUT");
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
