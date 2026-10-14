// tests/core/traffic.test.ts
// 流量观测（undici diagnostics_channel）的纯逻辑：记录形状、脱敏、上限裁剪、
// 录制放大、归属反查、attempt 递增、错误体捕获、来源分类。
//
// 驱动方式：直接往 `node:diagnostics_channel` 上 publish 假事件 —— 与 undici 真实
// 收发的事件同形（见 core/traffic.ts 顶部注释），比真发便宜且可观（真发要 key、
// 要钱，且偶发 400 不可控）。
import { describe, it, expect, beforeEach } from "vitest";
import { channel } from "node:diagnostics_channel";
import { traffic } from "../../src/main/core/traffic";

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
    traffic.setRecording(false);
    traffic.setCap(20, "keepLast");
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
        expect(r.reqBody).toEqual({ model: "x" });
    });

    it("400：记下上游错误体（扁平错误 + trace_id）", () => {
        const req = fireReq({ body: "{}" });
        fireRes(req, 400, { "content-type": "application/json" }, JSON.stringify({ message: "invalid request error trace_id: 1662a9a0", type: "invalid_request_error" }));

        const r = traffic.snapshot().records[0];
        expect(r.status).toBe(400);
        expect((r.resBody as { type: string }).type).toBe("invalid_request_error");
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

    it("常开上限：超过 keepLast 挤掉最旧的", () => {
        for (let i = 0; i < 25; i++) {
            const req = fireReq({ body: JSON.stringify({ model: `m${i}` }) });
            fireRes(req, 200, { "content-type": "application/json" }, "{}");
        }
        const { records } = traffic.snapshot();
        expect(records).toHaveLength(20);
        expect((records[0].reqBody as { model: string }).model).toBe("m5"); // m0..m4 被挤掉
    });

    it("录制模式：上限放大 + 捕获成功响应体 → 25 条全留", () => {
        traffic.setRecording(true);
        for (let i = 0; i < 25; i++) {
            const req = fireReq({ body: "{}" });
            fireRes(req, 200, { "content-type": "application/json" }, JSON.stringify({ n: i }));
        }
        const snap = traffic.snapshot();
        expect(snap).toMatchObject({ recording: true, cap: 500 });
        expect(snap.records).toHaveLength(25);
        expect(snap.records[24].resBody).toEqual({ n: 24 });
    });

    it("非录制模式：成功流式响应不捕获正文（只留说明）", () => {
        const req = fireReq({ body: "{}" });
        fireRes(req, 200, { "content-type": "text/event-stream" }, "data: hello\n\n");
        const r = traffic.snapshot().records[0];
        expect(typeof r.resBody).toBe("string");
        expect(r.resBody as string).toContain("流式");
    });

    it("traceId fallback：x-trace-id 缺省时退到 x-opencode-log-id", () => {
        const req = fireReq({ body: "{}" });
        fireRes(req, 200, { "content-type": "application/json", "x-opencode-log-id": "log-9" }, "{}");
        expect(traffic.snapshot().records[0].traceId).toBe("log-9");
    });
});
