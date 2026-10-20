// tests/core/error-triage.test.ts
// ═══════════════════════════════════════════════════════════════
// ##394「全局异常体系」三档判据 —— 表驱动，**每条都钉住 reason 非空**。
//
// 为什么必须纯函数 + 表驱动：判据若埋在边界里，「无码异常算不算 defect」这件事就只能靠
// 真造一次故障来验。纯函数让「哪档 / 哪个 code / 为什么」变成可断言的三个数。
//
// 覆盖四块：
//   ① defect —— `invariant()` 抛 ⇒ 必判 defect（bug 只能由判据认领）
//   ② external-recognized —— 已识别清单：网络码族 / ENOSPC / 429 / 401 / 403
//   ③ external-unknown —— 无码 / 有码但不认识 / HTTP 5xx（**上游有响应 ⇒ 不是网络问题**）
//   ④ 另一条轴：`TurnEndReason` → 三档（只映射，不动值域；预期内 = null）
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    InvariantError,
    KNOWN_EXTERNAL,
    invariant,
    isErrorCode,
    isInvariantError,
    probeTriage,
    triageOf,
    triageOfTurnEnd,
    TRIAGE_VALUES,
} from "../../src/shared/error-triage";
import { NETWORK_ERROR_CODES } from "../../src/shared/env-watch";
import type { TurnEndReason } from "../../src/main/services/local-blocks";

/** 造一个带原始字段的异常（形状对齐 Node / 各 SDK 的混杂现实） */
function errWith(fields: Record<string, unknown>, message = "boom"): Error {
    return Object.assign(new Error(message), fields);
}

describe("triageOf · defect（人为界定的判据）", () => {
    it("invariant 不满足 ⇒ 抛 InvariantError 且判 defect（带 code + detail）", () => {
        let caught: unknown = null;
        try {
            invariant(1 > 2, "agent/invariant-step-seq", "stepSeq 应单调：2 → 1");
        } catch (e) {
            caught = e;
        }
        expect(isInvariantError(caught)).toBe(true);
        const v = triageOf(caught);
        expect(v.triage).toBe("defect");
        expect(v.code).toBe("agent/invariant-step-seq");
        expect(v.reason).toContain("stepSeq 应单调");
        expect(v.reason.trim().length).toBeGreaterThan(0);
    });

    it("invariant 满足 ⇒ 什么都不抛", () => {
        expect(() => invariant("ok", "agent/invariant-step-seq")).not.toThrow();
    });

    it("invariant 的 code 不合命名约定 ⇒ 抛裸错（不冒充 defect 判据）", () => {
        expect(() => invariant(false, "stepSeq")).toThrow(/非法 code/);
        expect(() => invariant(false, "agent/Step_Seq")).toThrow(/非法 code/);
        expect(isErrorCode("agent/invariant-step-seq")).toBe(true);
        expect(isErrorCode("llm/rate-limited")).toBe(true);
        expect(isErrorCode("unknown/whatever")).toBe(false);
    });

    it("InvariantError 即使无 detail 也给非空 reason", () => {
        const v = triageOf(new InvariantError("agent/invariant-step-seq"));
        expect(v.triage).toBe("defect");
        expect(v.reason.trim().length).toBeGreaterThan(0);
    });
});

describe("triageOf · external-recognized（已识别的外部）", () => {
    it.each([...NETWORK_ERROR_CODES])("网络层 %s ⇒ recognized 且 code 归一化", (code) => {
        const v = triageOf(errWith({ code }));
        expect(v.triage).toBe("external-recognized");
        expect(v.code).toMatch(/^net\/[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(v.reason).toContain(code);
    });

    it("ENOSPC（磁盘满）⇒ recognized（fs/disk-full）", () => {
        const v = triageOf(errWith({ code: "ENOSPC" }, "no space left on device"));
        expect(v).toMatchObject({ triage: "external-recognized", code: "fs/disk-full" });
        expect(v.reason.length).toBeGreaterThan(0);
    });

    it("EDQUOT（配额用尽）⇒ recognized", () => {
        expect(triageOf(errWith({ code: "EDQUOT" }))).toMatchObject({
            triage: "external-recognized",
            code: "fs/quota-exceeded",
        });
    });

    it("HTTP 429（额度/限流）⇒ recognized（llm/rate-limited）", () => {
        const v = triageOf(errWith({ status: 429 }));
        expect(v).toMatchObject({ triage: "external-recognized", code: "llm/rate-limited" });
        expect(v.reason).toContain("429");
    });

    it("HTTP 401 / 403（认证 / 权限）⇒ recognized", () => {
        expect(triageOf(errWith({ statusCode: 401 })).code).toBe("llm/unauthorized");
        expect(triageOf(errWith({ response: { status: 403 } })).code).toBe("llm/forbidden");
    });

    it("已知清单里每条都写得出理由（空理由 = 该条不该在表里）", () => {
        for (const rule of KNOWN_EXTERNAL) {
            expect(rule.reason.trim().length).toBeGreaterThan(0);
            expect(isErrorCode(rule.code)).toBe(true);
        }
    });

    it("每个网络码都在清单里命中（env-watch 加码不会静默落进 unknown）", () => {
        for (const code of NETWORK_ERROR_CODES) {
            expect(triageOf(errWith({ code })).triage).toBe("external-recognized");
        }
    });
});

describe("triageOf · external-unknown（未识别的外部：不猜）", () => {
    it("无码也没有 HTTP 状态 ⇒ unknown 且 code = null（不编码）", () => {
        const v = triageOf(new Error("something odd"));
        expect(v.triage).toBe("external-unknown");
        expect(v.code).toBeNull();
        expect(v.reason).toContain("无法判定");
    });

    it("非 Error 的抛出物（字符串 / undefined）⇒ 同样 unknown", () => {
        for (const x of ["磁盘坏了", undefined, 42, null]) {
            const v = triageOf(x);
            expect(v.triage).toBe("external-unknown");
            expect(v.reason.trim().length).toBeGreaterThan(0);
        }
    });

    it("有码但不认识 ⇒ unknown，原始码原样带回（供统计哪类最该被识别）", () => {
        const v = triageOf(errWith({ code: "EACCES" }));
        expect(v.triage).toBe("external-unknown");
        expect(v.code).toBe("EACCES");
    });

    it("HTTP 5xx ⇒ unknown（上游有响应 = 网络通着，那是服务端故障 ##369）", () => {
        const v = triageOf(errWith({ status: 500 }));
        expect(v.triage).toBe("external-unknown");
        expect(v.reason).toContain("500");
    });

    it("HTTP 请求超时（AbortError / 无 code 无 status）⇒ unknown —— 别与连接层 ETIMEDOUT 混同", () => {
        // `ETIMEDOUT` 进 KNOWN_EXTERNAL 是因为「连接层**根本没应答**」= 说得出「对端不在」；
        // 「请求超时」是对端接了、却没在时限内说完 —— 上游回了 HTTP 就说明网络通着（##369 口径），
        // 那是服务端侧 / 未识别。没有 code、没有 status 时**不许**按 message 里的 "timeout" 猜成 recognized。
        const abortErr = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
        expect(triageOf(abortErr)).toMatchObject({ triage: "external-unknown", code: null });
        expect(triageOf(abortErr).reason.trim().length).toBeGreaterThan(0);
        const requestTimeout = new Error("The operation was aborted due to timeout");
        expect(triageOf(requestTimeout)).toMatchObject({ triage: "external-unknown", code: null });
        // 反面对照：连接层超时仍须是 recognized —— 两条口径同时绑住，改任一条都会红
        expect(triageOf(errWith({ code: "ETIMEDOUT" }, "connect ETIMEDOUT"))).toMatchObject({
            triage: "external-recognized",
            code: "net/connect-timeout",
        });
    });

    it("错误被包在 cause 里也认得出来（SDK 的常态形状）", () => {
        const wrapped = errWith({ cause: errWith({ code: "ECONNRESET" }, "socket hang up") });
        expect(triageOf(wrapped)).toMatchObject({ triage: "external-recognized", code: "net/connection-reset" });
        expect(probeTriage(wrapped).code).toBe("ECONNRESET");
    });

    it("三档取值只有这三个（UI 样式键与判据同源）", () => {
        expect([...TRIAGE_VALUES]).toEqual(["defect", "external-recognized", "external-unknown"]);
    });
});

describe("triageOfTurnEnd · 轮末映射（只映射，不动值域）", () => {
    const cases: Array<[string, TurnEndReason, string | null, string | null]> = [
        ["completed", { type: "completed", data: {} }, null, null],
        ["max-steps", { type: "max-steps", data: { steps: 30, limit: 30 } }, "external-recognized", "llm/step-limit"],
        ["max-tokens", { type: "max-tokens", data: { maxOutputTokens: 8192 } }, "external-recognized", "llm/token-limit"],
        ["aborted:user", { type: "aborted", data: { source: "user" } }, null, null],
        ["aborted:detached", { type: "aborted", data: { source: "detached" } }, "external-unknown", "agent/aborted-detached"],
        // legacy：旧版停止按钮没带 reason（`src/shared/turn-end.ts:15-19` 头注）⇒ 同样是用户停止，
        // 判 null 而不是 unknown —— 否则历史「点停止」整批进裁定池（##266 review1 R1）。
        ["aborted:abort(legacy 用户停止)", { type: "aborted", data: { source: "abort" } }, null, null],
        ["interrupted", { type: "interrupted", data: {} }, "external-unknown", "agent/interrupted"],
        ["error:budget", { type: "error", data: { source: "budget", message: "budget" } }, "external-recognized", "llm/budget-exceeded"],
        ["error:llm", { type: "error", data: { source: "llm", message: "boom" } }, "external-unknown", "llm/error"],
        ["error:stream", { type: "error", data: { source: "stream", message: "cut" } }, "external-unknown", "llm/stream-error"],
    ];

    it.each(cases)("%s", (_name, reason, triage, code) => {
        const v = triageOfTurnEnd(reason);
        expect(v.triage).toBe(triage);
        expect(v.code).toBe(code);
        expect(v.reason.trim().length).toBeGreaterThan(0);
    });

    it("预期内（completed / 用户停止，含 legacy abort）不算 external-unknown —— 别把「正常」标成可疑", () => {
        expect(triageOfTurnEnd({ type: "completed", data: {} }).triage).toBeNull();
        expect(triageOfTurnEnd({ type: "aborted", data: { source: "user" } }).triage).toBeNull();
        // legacy：旧记录里用户停止也是 "abort"（src/shared/turn-end.ts:15-19）⇒ 同属预期内
        const legacy = triageOfTurnEnd({ type: "aborted", data: { source: "abort" } });
        expect(legacy.triage).toBeNull();
        expect(legacy.code).toBeNull();
        expect(legacy.reason).toContain("legacy");
        // 对照："detached" / 未知来源仍须是 unknown —— 别顺手把「真未识别」也吞成预期内
        expect(triageOfTurnEnd({ type: "aborted", data: { source: "detached" } }).triage).toBe("external-unknown");
        expect(triageOfTurnEnd({ type: "aborted", data: { source: "??" } }).triage).toBe("external-unknown");
    });
});
