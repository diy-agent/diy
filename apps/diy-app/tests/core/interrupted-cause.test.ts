// tests/core/interrupted-cause.test.ts
// ═══════════════════════════════════════════════════════════════
// ##416「崩溃恢复的中断要能说出原因」—— 冷读判定 why 的判据测试。
//
// 两条铁律（与 rule.err-triage 同轴），每条都钉住：
//   ① **能命名才命名**：窗口内确有退出痕迹 ⇒ 给出 why + code（restart / crash 两类）
//   ② **查不到就不猜**：窗口空 / 认不出的 kind / 老记录没 why ⇒ null（上层保持 external-unknown）
// 另覆盖：证据文件不存在时 IO 侧**不抛**（会话加载路径不能被读盘失败带崩）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    classifyInterruptedCause,
    codeOfInterruptedWhy,
    isNamedInterruptedWhy,
    turnStartedAtOf,
    type CauseEvidence,
} from "../../src/shared/interrupted-cause";
import { readAppExitLog, readCauseEvidence, readMinidumps } from "../../src/main/services/interrupted-cause";

const T0 = Date.parse("2026-10-22T10:00:00.000Z");
const T1 = T0 + 60_000;

function ev(exits: CauseEvidence["exits"] = [], dumps: CauseEvidence["dumps"] = []): CauseEvidence {
    return { exits, dumps };
}

describe("codeOfInterruptedWhy：认得出的才给码", () => {
    it("信号族 ⇒ agent/app-restart；异常族 / minidump ⇒ agent/app-crash", () => {
        expect(codeOfInterruptedWhy("app-exit:SIGTERM")).toBe("agent/app-restart");
        expect(codeOfInterruptedWhy("app-exit:SIGINT")).toBe("agent/app-restart");
        expect(codeOfInterruptedWhy("app-exit:SIGHUP")).toBe("agent/app-restart");
        expect(codeOfInterruptedWhy("app-exit:electron-dev-restart")).toBe("agent/app-restart");
        expect(codeOfInterruptedWhy("app-exit:uncaughtException")).toBe("agent/app-crash");
        expect(codeOfInterruptedWhy("app-exit:unhandledRejection")).toBe("agent/app-crash");
        expect(codeOfInterruptedWhy("crash:minidump")).toBe("agent/app-crash");
    });

    it("认不出的一律 null（老记录无 why / 未知 kind / 裸 kind）", () => {
        expect(codeOfInterruptedWhy(undefined)).toBeNull();
        expect(codeOfInterruptedWhy("")).toBeNull();
        expect(codeOfInterruptedWhy("SIGTERM")).toBeNull(); // 少了 app-exit: 前缀
        expect(codeOfInterruptedWhy("app-exit:whatever")).toBeNull();
        expect(codeOfInterruptedWhy("crash:unknown")).toBeNull();
        expect(isNamedInterruptedWhy("app-exit:SIGTERM")).toBe(true);
        expect(isNamedInterruptedWhy("")).toBe(false);
    });
});

describe("turnStartedAtOf：轮次开始毫秒从 turnId 读", () => {
    it("`t<ms>` ⇒ 毫秒；认不出的形态 ⇒ null（没有下界就不判窗口）", () => {
        expect(turnStartedAtOf(`t${T0}`)).toBe(T0);
        expect(turnStartedAtOf("t404")).toBeNull();
        expect(turnStartedAtOf("turn_1")).toBeNull();
        expect(turnStartedAtOf("")).toBeNull();
    });
});

describe("classifyInterruptedCause：窗口内证据 → 可命名原因", () => {
    it("窗口内有 SIGTERM ⇒ app-exit:SIGTERM + agent/app-restart，证据路径带回来", () => {
        const c = classifyInterruptedCause(
            T0,
            T1,
            ev([{ ts: new Date(T0 + 1000).toISOString(), kind: "SIGTERM", file: "/h/log/app-exit.jsonl" }]),
        );
        expect(c?.why).toBe("app-exit:SIGTERM");
        expect(c?.code).toBe("agent/app-restart");
        expect(c?.evidence).toBe("/h/log/app-exit.jsonl");
        expect(c?.at).toBe(T0 + 1000);
    });

    it("窗口内有 uncaughtException ⇒ agent/app-crash", () => {
        const c = classifyInterruptedCause(
            T0,
            T1,
            ev([{ ts: new Date(T0 + 2000).toISOString(), kind: "uncaughtException", file: "/h/log/app-exit.jsonl" }]),
        );
        expect(c?.why).toBe("app-exit:uncaughtException");
        expect(c?.code).toBe("agent/app-crash");
    });

    it("窗口内有新 minidump ⇒ crash:minidump + agent/app-crash", () => {
        const c = classifyInterruptedCause(T0, T1, ev([], [{ path: "/h/log/crashes/pending/a.dmp", mtimeMs: T0 + 500 }]));
        expect(c?.why).toBe("crash:minidump");
        expect(c?.code).toBe("agent/app-crash");
        expect(c?.evidence).toBe("/h/log/crashes/pending/a.dmp");
    });

    it("窗口外（早于本轮开始 / 晚于此刻）的证据不算 —— 不许把几天前的退出算到这一轮", () => {
        const c = classifyInterruptedCause(
            T0,
            T1,
            ev(
                [{ ts: new Date(T0 - 10).toISOString(), kind: "SIGTERM" }, { ts: new Date(T1 + 10).toISOString(), kind: "SIGTERM" }],
                [{ path: "/h/x.dmp", mtimeMs: T0 - 1000 }],
            ),
        );
        expect(c).toBeNull();
    });

    it("多条证据取**最新**的一条（窗口可能跨多次重启）", () => {
        const c = classifyInterruptedCause(
            T0,
            T1,
            ev([
                { ts: new Date(T0 + 1000).toISOString(), kind: "SIGTERM" },
                { ts: new Date(T0 + 5000).toISOString(), kind: "uncaughtException" },
            ]),
        );
        expect(c?.why).toBe("app-exit:uncaughtException");
    });

    it("什么都没有 ⇒ null（SIGKILL / 断电确实说不出，不许猜）", () => {
        expect(classifyInterruptedCause(T0, T1, ev())).toBeNull();
    });

    it("窗口内只有认不出的 kind ⇒ null（不硬命名）", () => {
        expect(
            classifyInterruptedCause(T0, T1, ev([{ ts: new Date(T0 + 1000).toISOString(), kind: "mystery-exit" }])),
        ).toBeNull();
    });

    it("坏时间戳（ts 解析失败）不参与判定，也不抛", () => {
        expect(() => classifyInterruptedCause(T0, T1, ev([{ ts: "not-a-date", kind: "SIGTERM" }]))).not.toThrow();
        expect(classifyInterruptedCause(T0, T1, ev([{ ts: "not-a-date", kind: "SIGTERM" }]))).toBeNull();
    });
});

describe("IO 侧：证据文件缺失 / 内容腐坏时不抛", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const tmpHome = (): string => {
        const d = mkdtempSync(join(tmpdir(), "i416-"));
        dirs.push(d);
        return d;
    };

    it("数据根下什么都没有 ⇒ 空证据（不是异常）", () => {
        const home = tmpHome();
        expect(readAppExitLog(home)).toEqual([]);
        expect(readMinidumps(home)).toEqual([]);
        expect(readCauseEvidence(home)).toEqual({ exits: [], dumps: [] });
    });

    it("坏行跳过、好行照收；minidump 按 mtime 收进证据", () => {
        const home = tmpHome();
        mkdirSync(join(home, "log", "crashes", "pending"), { recursive: true });
        writeFileSync(
            join(home, "log", "app-exit.jsonl"),
            [
                JSON.stringify({ ts: new Date(T0).toISOString(), kind: "SIGTERM", pid: 1 }),
                "{ 半截行",
                JSON.stringify({ ts: 1, kind: "??" }), // 形状不对：跳过
                "",
            ].join("\n"),
            "utf-8",
        );
        writeFileSync(join(home, "log", "crashes", "pending", "a.dmp"), "x");
        writeFileSync(join(home, "log", "crashes", "pending", "not-a-dump.txt"), "x");

        const evidence = readCauseEvidence(home);
        expect(evidence.exits).toHaveLength(1);
        expect(evidence.exits[0]!.kind).toBe("SIGTERM");
        expect(evidence.exits[0]!.file).toBe(join(home, "log", "app-exit.jsonl"));
        expect(evidence.dumps).toHaveLength(1);
        expect(evidence.dumps[0]!.path.endsWith("a.dmp")).toBe(true);
        // 证据能被判定消费：窗口覆盖"现在" ⇒ 命中最新的那条
        expect(classifyInterruptedCause(T0 - 1000, T0 + 1000, evidence)?.why).toBe("app-exit:SIGTERM");
    });
});
