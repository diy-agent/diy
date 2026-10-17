// tests/core/model-unavailable.test.ts
// 🎯 「模型不可用」判据的契约（##369 ①）——**表驱动**：每行一条真实/构造的错误事实 + 期望结论。
//
// 为什么要穷举：这条判据决定"顶栏 bar 亮不亮"。判宽了 → 上游一抖就亮，用户就不看了
// （告警疲劳）；判窄了 → 模型真挂掉时又是静默失败（就是本任务要消灭的形态）。
// 所以边界两侧都要有用例：命中的四类各一条，5xx / 超时 / 其它 4xx 明确**不**命中。

import { describe, it, expect } from "vitest";
import {
    MAX_UPSTREAM_CHARS,
    classifyModelUnavailable,
    probeModelError,
    upstreamText,
    type ModelErrorProbe,
} from "../../src/shared/model-unavailable";
import { noticeFromError, unavailableNoticeFromLocal } from "../../src/main/services/model-notice";

/** 表：一行 = 一份错误事实 → 期望结论（`null` = 不命中，字符串 = 期望的 kind） */
const CASES: Array<{
    name: string;
    probe: ModelErrorProbe;
    kind: "coming-soon" | "unknown-model" | "auth" | "quota" | null;
}> = [
    // ── 命中：模型未上架（实测形态：上游把它放在 body 里，状态码是 400）──
    {
        name: "model_coming_soon（400 + 上游原文）",
        probe: {
            statusCode: 400,
            responseBody: JSON.stringify({ error: { message: "[model_coming_soon] This model is coming soon." } }),
            message: null,
        },
        kind: "coming-soon",
    },
    {
        name: "coming soon 只在 message 里（连响应体都没拿到）",
        probe: { statusCode: null, responseBody: null, message: "[model_coming_soon] This model is coming soon." },
        kind: "coming-soon",
    },
    // ── 命中：模型 id 不认识 ──
    { name: "404（模型不在可用清单）", probe: { statusCode: 404, responseBody: null, message: "Not Found" }, kind: "unknown-model" },
    {
        name: "unknown model（无状态码，文案兜底）",
        probe: { statusCode: null, responseBody: "unknown model: chen56@opencode-go/longcat-9", message: null },
        kind: "unknown-model",
    },
    // ── 命中：认证 ──
    { name: "401（key 未配/失效）", probe: { statusCode: 401, responseBody: '{"error":"invalid api key"}', message: null }, kind: "auth" },
    { name: "403（key 无权限）", probe: { statusCode: 403, responseBody: null, message: "Forbidden" }, kind: "auth" },
    // ── 命中：配额 ──
    { name: "429（配额/限流）", probe: { statusCode: 429, responseBody: '{"error":"rate limit exceeded"}', message: null }, kind: "quota" },

    // ── 不命中：上游服务端故障（另一类问题：该等，不是该配模型）──
    { name: "500", probe: { statusCode: 500, responseBody: "internal error", message: null }, kind: null },
    { name: "503", probe: { statusCode: 503, responseBody: null, message: "Service Unavailable" }, kind: null },
    // ── 不命中：网络/超时（根本没有响应，也就没有状态码）──
    { name: "超时（fetch failed / timeout）", probe: { statusCode: null, responseBody: null, message: "fetch failed: timeout" }, kind: null },
    { name: "空错误（什么线索都没有）", probe: { statusCode: null, responseBody: null, message: null }, kind: null },
    // ── 不命中：其它 4xx（既不是模型、也不是认证/配额）──
    { name: "400 参数错误", probe: { statusCode: 400, responseBody: '{"error":"invalid request body"}', message: null }, kind: null },
];

describe("classifyModelUnavailable（表驱动）", () => {
    for (const c of CASES) {
        it(`${c.kind === null ? "不命中" : `命中 ${c.kind}`} —— ${c.name}`, () => {
            const v = classifyModelUnavailable(c.probe);
            if (c.kind === null) {
                expect(v.hit).toBe(false);
                // 不命中也要给可读理由（答"为什么没提示"不该需要读代码）
                if (!v.hit) expect(v.reason.length).toBeGreaterThan(0);
            } else {
                expect(v.hit).toBe(true);
                if (v.hit) {
                    expect(v.kind).toBe(c.kind);
                    expect(v.reason.length).toBeGreaterThan(0);
                }
            }
        });
    }

    it("不命中的理由能区分「5xx」与「没有状态码」两类（否则用户不知道是该等还是该查网络）", () => {
        const five = classifyModelUnavailable({ statusCode: 502, responseBody: null, message: null });
        const noCode = classifyModelUnavailable({ statusCode: null, responseBody: null, message: "fetch failed" });
        expect(five.hit).toBe(false);
        expect(noCode.hit).toBe(false);
        if (!five.hit && !noCode.hit) expect(five.reason).not.toBe(noCode.reason);
    });

    it("判据顺序即优先级：401 且文案含 model_coming_soon → 判 model 未上架（不要报成认证失败）", () => {
        const v = classifyModelUnavailable({
            statusCode: 401,
            responseBody: null,
            message: "[model_coming_soon] This model is coming soon.",
        });
        expect(v.hit && v.kind).toBe("coming-soon");
    });

    it("上游原文进 upstream（用户要看到「上游到底说了什么」）", () => {
        const v = classifyModelUnavailable({
            statusCode: 400,
            responseBody: "[model_coming_soon] This model is coming soon.",
            message: null,
        });
        expect(v.hit).toBe(true);
        if (v.hit) expect(v.upstream).toContain("model_coming_soon");
    });
});

describe("upstreamText / probeModelError", () => {
    it("upstream 超长被截断（bar 放不下长正文）", () => {
        const long = "x".repeat(MAX_UPSTREAM_CHARS + 500);
        const t = upstreamText({ statusCode: 401, responseBody: long, message: null });
        expect(t.length).toBe(MAX_UPSTREAM_CHARS + 1); // +1 = 省略号
        expect(t.endsWith("…")).toBe(true);
    });

    it("upstream 压掉换行（bar 是单行条，原始 body 常是多行 JSON）", () => {
        const t = upstreamText({ statusCode: 404, responseBody: "{\n  \"a\": 1\n}", message: null });
        expect(t).not.toContain("\n");
    });

    it("probe：从 SDK 形状的错误对象取 statusCode / responseBody / message", () => {
        const p = probeModelError({ statusCode: 429, responseBody: '{"error":"quota"}', message: "Too Many Requests" });
        expect(p).toEqual({ statusCode: 429, responseBody: '{"error":"quota"}', message: "Too Many Requests" });
    });

    it("probe：顺着 cause / lastError 链下一层（重试耗尽后 SDK 包一层）", () => {
        const wrapped = { message: "retries exhausted", lastError: { statusCode: 404, responseBody: "unknown model", message: "Not Found" } };
        const p = probeModelError(wrapped);
        expect(p.statusCode).toBe(404);
        expect(p.responseBody).toBe("unknown model");
        // 外层 message 先到先得：它是"重试耗尽"，内层才是上游原文（两者都留着，判据看 body）
        expect(p.message).toBe("retries exhausted");
    });

    it("probe：普通 Error 只有 message；非对象值也能兜住（不再抛）", () => {
        expect(probeModelError(new Error("boom")).message).toBe("boom");
        expect(probeModelError("bare string").message).toBe("bare string");
        expect(probeModelError(null)).toEqual({ statusCode: null, responseBody: null, message: null });
    });
});

describe("noticeFromError（main 侧组装）", () => {
    const ctx = { taskUri: "projects/4/tasks/369", personaId: "9", personaName: "for-test", model: "chen56@x/longcat-9" };

    it("命中 → 通知带齐 bar 要显示的全部字段", () => {
        const n = noticeFromError({ statusCode: 400, responseBody: "[model_coming_soon] coming soon", message: null }, ctx);
        expect(n).not.toBeNull();
        expect(n!.kind).toBe("coming-soon");
        expect(n!.model).toBe("chen56@x/longcat-9");
        expect(n!.personaName).toBe("for-test");
        expect(n!.taskUri).toBe("projects/4/tasks/369");
        expect(n!.upstream).toContain("model_coming_soon");
        expect(n!.id.length).toBeGreaterThan(0);
    });

    it("不命中 → null（5xx 不产生通知：bar 不该为服务端抖动而亮）", () => {
        expect(noticeFromError({ statusCode: 503, responseBody: "bad gateway", message: null }, ctx)).toBeNull();
        expect(noticeFromError({ statusCode: null, responseBody: null, message: "fetch failed" }, ctx)).toBeNull();
    });

    it("本地装配期确知（模型 id 不在清单里）→ 也产出一条通知（不经文案判据）", () => {
        const n = unavailableNoticeFromLocal("未知模型 chen56@x/gone（可选：diy agent local models）", ctx);
        expect(n.kind).toBe("unknown-model");
        expect(n.model).toBe("chen56@x/longcat-9");
        expect(n.upstream).toContain("未知模型");
        expect(n.statusCode).toBeNull();
    });

    it("id 唯一（同一毫秒内两条也不撞：dismiss 靠它定位）", () => {
        const e = { statusCode: 401, responseBody: null, message: "unauthorized" };
        const a = noticeFromError(e, ctx);
        const b = noticeFromError(e, ctx);
        expect(a!.id).not.toBe(b!.id);
    });
});
