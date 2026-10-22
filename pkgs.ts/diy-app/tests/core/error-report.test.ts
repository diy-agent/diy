// tests/core/error-report.test.ts
// ═══════════════════════════════════════════════════════════════
// ##411「异常出口全链路丢 stack」—— 落盘 / 限流 / 归一 + 真链路接线。
//
// 病灶：业务链上异常只走 `errText()`，`stack` / `code` / 现场全部蒸发；
// `Cannot read properties of undefined` 挡路 5 小时，ops.jsonl 36220 行零痕迹。
//
// 本文件钉四件事：
//   ① `errText` 只有一份（Error / 类 Error / 字符串 / 其它 四档回落）
//   ② `reportError` 真落盘，且**含 stack + code**（用户面仍只一句话）
//   ③ 同错 100 次 ⇒ 限流（每分钟条数 ≤ N）
//   ④ 反证：把 `reportError` 换成 `errText` ⇒ 同一条断言必红
//   ⑤ 真链路：`room-service.collectTurn` 捕到抛错 ⇒ 落一条 `room/deliver`
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    DEFAULT_ERROR_LOG_LIMIT_PER_MIN,
    MAX_STACK_CHARS,
    buildErrorReport,
    dateKey,
    errText,
    errorCodeOf,
    errorReportKey,
    ErrorRateLimiter,
} from "../../src/shared/error-report";
import {
    errorLogFile,
    reportError,
    resetErrorReportLimiter,
} from "../../src/main/services/error-report";
import { collectTurn } from "../../src/main/services/room-service";
import type { Op } from "../../src/main/services/local-blocks";

/** 带 code 的异常（本仓约定：`<域>/<kebab>`） */
function codedError(message = "Cannot read properties of undefined", code = "agent/stub-crash"): Error {
    return Object.assign(new Error(message), { code });
}

let home = "";
let now = new Date(2026, 9, 22, 12, 0, 0);

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "diy-err-report-"));
    now = new Date(2026, 9, 22, 12, 0, 0);
    resetErrorReportLimiter();
});

function readRows(h: string, d: Date): Array<Record<string, unknown>> {
    const f = errorLogFile(h, d);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 反证用的**同一份**断言：报告必须「有一条 + 带 stack + 带 code」 */
function assertReported(h: string, d: Date): void {
    const rows = readRows(h, d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["code"]).toBe("agent/stub-crash");
    expect(String(rows[0]!["stack"] ?? "")).toContain("error-report.test");
    expect(rows[0]!["ctx"]).toEqual({ where: "test/unit" });
}

describe("errText · 全仓唯一实现（两处旧拷贝的合并）", () => {
    it("Error → message", () => {
        expect(errText(new Error("boom"))).toBe("boom");
    });

    it("类 Error（跨进程反序列化 / SDK 抛出物）→ message 字段（旧版 room-service 拷贝认不出来）", () => {
        expect(errText({ message: "反序列化错误", name: "StubError" })).toBe("反序列化错误");
    });

    it("字符串原样 · 其它 String() · nullish 兜底", () => {
        expect(errText("裸字符串")).toBe("裸字符串");
        expect(errText(42)).toBe("42");
        expect(errText(null)).toBe("未知错误");
    });
});

describe("errorCodeOf / buildErrorReport", () => {
    it("code 从错误链原样读出；没有就是 null（**不编**）", () => {
        expect(errorCodeOf(codedError())).toBe("agent/stub-crash");
        expect(errorCodeOf(new Error("no code"))).toBe(null);
        // 包了一层 cause：照样读得到
        expect(errorCodeOf(Object.assign(new Error("outer"), { cause: codedError() }))).toBe("agent/stub-crash");
    });

    it("报告形状 = {ts, code, name, message, stack, ctx}，stack 超长截断", () => {
        const r = buildErrorReport(codedError(), { where: "test/unit" }, now);
        expect(r.ts).toBe(now.toISOString());
        expect(r.code).toBe("agent/stub-crash");
        expect(r.name).toBe("Error");
        expect(r.message).toBe("Cannot read properties of undefined");
        expect(r.stack).toContain("at ");
        expect(r.ctx).toEqual({ where: "test/unit" });

        const huge = Object.assign(new Error("big"), { stack: "x".repeat(MAX_STACK_CHARS + 100) });
        expect(buildErrorReport(huge, { where: "t" }, now).stack.endsWith("…[truncated]")).toBe(true);
    });

    it("非 Error 抛掷物也给得出 name（typeof）与空 stack", () => {
        const r = buildErrorReport("裸字符串", { where: "t" }, now);
        expect(r.name).toBe("string");
        expect(r.stack).toBe("");
        expect(r.message).toBe("裸字符串");
    });

    it("限流键只看 code + message（stack 每次都不同，不能进键）", () => {
        const a = buildErrorReport(codedError("same"), { where: "a" }, now);
        const b = buildErrorReport(codedError("same"), { where: "b" }, new Date(now.getTime() + 1000));
        expect(errorReportKey(a)).toBe(errorReportKey(b));
        expect(a.stack === b.stack).toBe(false); // 不同的构造点 ⇒ stack 不同
    });
});

describe("reportError · 落盘", () => {
    it("① 抛一个带 code 的 Error ⇒ 落盘一条含 stack（用户面仍只一句话）", () => {
        const res = reportError(codedError(), { where: "test/unit" }, { home, now });
        expect(res.written).toBe(true);
        expect(res.suppressed).toBe(false);
        assertReported(home, now);
        // 落点 = log/error/<YYYY-MM-DD>.jsonl
        expect(res.file.endsWith(join("log", "error", `${dateKey(now)}.jsonl`))).toBe(true);
    });

    it("② 同错 100 次 ⇒ 限流生效（条数 = N，不是 100）", () => {
        for (let i = 0; i < 100; i++) {
            reportError(codedError("刷盘循环"), { where: "test/unit" }, { home, now: new Date(now.getTime() + i) });
        }
        const rows = readRows(home, now);
        expect(rows).toHaveLength(DEFAULT_ERROR_LOG_LIMIT_PER_MIN);
        expect(rows.length).toBeLessThan(100);
        // 窗口滑过去之后又能写（不是永久封死）
        const later = new Date(now.getTime() + 61_000);
        expect(reportError(codedError("刷盘循环"), { where: "test/unit" }, { home, now: later }).written).toBe(true);
    });

    it("③ 限流器本身：滑动窗口 + reset", () => {
        const l = new ErrorRateLimiter(2, 1000);
        expect(l.allow("k", 0)).toBe(true);
        expect(l.allow("k", 1)).toBe(true);
        expect(l.allow("k", 2)).toBe(false);
        expect(l.allow("k", 1500)).toBe(true); // 0/1 已过期
        l.reset();
        expect(l.allow("k", 1500)).toBe(true);
    });

    it("④ 落盘失败不反噬（目录不可写 ⇒ written=false，不抛）", () => {
        const res = reportError(codedError(), { where: "test/unit" }, { home: join(home, "nope", "\0bad"), now });
        expect(res.written).toBe(false);
        // 不抛即达标
    });

    it("⑤ 反证：把 reportError 换成 errText ⇒ 同一个断言必红", () => {
        // 「修前的形状」：调用点只做 errText(e)（旧 local-agent / room-service 的全部作为）
        expect(() => {
            errText(codedError());
            assertReported(home, now);
        }).toThrow();
        // 同一断言在真实现下通过 —— 证明上面那条红不是空转
        reportError(codedError(), { where: "test/unit" }, { home, now });
        assertReported(home, now);
    });
});

describe("真链路 · room-service 投递失败（桩 run 生成器）", () => {
    it("collectTurn 捕到抛错 ⇒ 落一条 room/deliver（含 stack），返回文案仍是「投递失败：…」", async () => {
        // 用**真** DIY_HOME（测试变体 = mkdtemp），断言落在真实日志目录里
        const before = readRows(process.env["DIY_HOME"] ?? home, new Date());
        const r = await collectTurn(async function* (): AsyncGenerator<Op> {
            // 先给一条无关注再抛：走的是 collectTurn 的 catch 分支（真链路的失败形态）
            yield { op: "start", kind: "error" } as unknown as Op;
            throw codedError("模型挂了");
        });
        expect(r.reply).toBe("");
        expect(r.error).toBe("投递失败：模型挂了");

        const homeReal = process.env["DIY_HOME"] ?? home;
        const after = readRows(homeReal, new Date());
        const added = after.slice(before.length);
        const hit = added.find((row) => row["code"] === "agent/stub-crash");
        expect(hit, `新增行：${JSON.stringify(added)}`).toBeTruthy();
        expect((hit!["ctx"] as Record<string, unknown>)["where"]).toBe("room/deliver");
        expect(String(hit!["stack"] ?? "")).toContain("error-report.test");
        // 用户面不外露 stack
        expect(r.error).not.toContain("at ");
    });
});
