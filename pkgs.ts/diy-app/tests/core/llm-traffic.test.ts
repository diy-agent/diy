// tests/core/llm-traffic.test.ts
// LLM 流量 tap 的纯逻辑：记录形状、敏感头脱敏、保底环裁剪、录制模式放大。
//
// 为什么单测：这些断言都在「谁什么时候被挤掉」「哪个头留几位」这类确定性边界上，
// 用桩 fetch 摆出来比真发便宜得多（真发还要 key、还要钱，且偶发 400 不可控）。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { llmTraffic } from "../../src/main/core/llm-traffic";

const RUN = {
    session: "ses_test",
    taskUri: "projects/1/tasks/2",
    turnId: "turn-1",
    provider: "custom:goat",
    model: "deepseek/deepseek-v4.1-flash",
    baseUrl: "https://api.example.com/provider/v1",
    maxRetries: 2,
};

function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-trace-id": "trace-abc-123" },
    });
}

function call(tap: typeof fetch, body: unknown = { model: "x" }) {
    return tap("https://api.example.com/provider/v1/chat/completions", {
        method: "POST",
        headers: { "x-opencode-session": RUN.session, authorization: "Bearer sk-abcdefgh" },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.restoreAllMocks();
    llmTraffic.clear();
    llmTraffic.setRecording(false);
    llmTraffic.setCap(20, "keepLast");
    llmTraffic.noteRun(RUN);
});
afterEach(() => vi.unstubAllGlobals());

describe("llm-traffic tap", () => {
    it("成功往返：记 status / traceId / 请求头（脱敏）/ 请求体，归属反查得到 task", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ ok: true })));
        await call(llmTraffic.tap());

        const { records } = llmTraffic.snapshot();
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
        expect(r.reqHeaders.authorization).toBe("Bearer ****efgh"); // 只留尾 4 位
        expect(r.reqBody).toEqual({ model: "x" });
    });

    it("400：记下上游错误体（扁平错误 + trace_id）", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonRes({ message: "invalid request error trace_id: 1662a9a0", type: "invalid_request_error" }, 400)),
        );
        await call(llmTraffic.tap());

        const r = llmTraffic.snapshot().records[0];
        expect(r.status).toBe(400);
        expect((r.resBody as { type: string }).type).toBe("invalid_request_error");
    });

    it("重试：同一轮内 attempt 逐次自增（ai-sdk 每次重试即一次 fetch）", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, 429)));
        const tap = llmTraffic.tap();
        await call(tap);
        await call(tap);
        expect(llmTraffic.snapshot().records.map((r) => r.attempt)).toEqual([1, 2]);
    });

    it("网络异常：status 落 null 并记 err，异常原样抛出（不吞）", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("connect ETIMEDOUT");
        }));
        await expect(call(llmTraffic.tap())).rejects.toThrow("connect ETIMEDOUT");
        const r = llmTraffic.snapshot().records[0];
        expect(r.status).toBeNull();
        expect(r.err).toContain("ETIMEDOUT");
    });

    it("保底环：超过 keepLast 挤掉最旧的", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonRes({})));
        const tap = llmTraffic.tap();
        for (let i = 0; i < 25; i++) await call(tap, { model: `m${i}` });
        const { records } = llmTraffic.snapshot();
        expect(records).toHaveLength(20);
        expect((records[0].reqBody as { model: string }).model).toBe("m5"); // m0..m4 被挤掉
    });

    it("录制模式：上限放大 → 25 条全留（保底环只留 20）", async () => {
        llmTraffic.setRecording(true);
        vi.stubGlobal("fetch", vi.fn(async () => jsonRes({})));
        const tap = llmTraffic.tap();
        for (let i = 0; i < 25; i++) await call(tap);
        expect(llmTraffic.snapshot()).toMatchObject({ recording: true, cap: 500 });
        expect(llmTraffic.snapshot().records).toHaveLength(25);
    });

    it("traceId fallback：x-trace-id 缺省时退到 x-opencode-log-id", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response("{}", {
                        status: 200,
                        headers: { "content-type": "application/json", "x-opencode-log-id": "log-9" },
                    }),
            ),
        );
        await call(llmTraffic.tap());
        expect(llmTraffic.snapshot().records[0].traceId).toBe("log-9");
    });

    it("未登记 session：记录仍留（taskUri null），不抛", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonRes({})));
        await llmTraffic.tap()("https://api.example.com/provider/v1/chat/completions", {
            method: "POST",
            headers: { "x-opencode-session": "ses_unknown" },
            body: "{}",
        });
        const r = llmTraffic.snapshot().records[0];
        expect(r.taskUri).toBeNull();
        expect(r.session).toBe("ses_unknown");
    });
});
