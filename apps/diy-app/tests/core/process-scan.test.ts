// tests/core/process-scan.test.ts
// 🎯 `killOwnedProc` 的**安全闸**（OS 无关）：lineage-only 认领不能直接杀。
//
// Windows 无进程组时，孤儿只能靠 PPID 锚点认领 —— 那只证明「父链指向我们记录过的根」，
// 不能证明「不是 pid 复用出来的新进程」。没有创建时刻就不许动手（选择阶段的时间窗是前提）。

import { describe, expect, it } from "vitest";
import { killOwnedProc } from "../../src/main/services/process-scan";

describe("killOwnedProc —— lineage 认领的严格闸", () => {
    it("claim=lineage 且没有创建时刻 ⇒ 拒绝（不发任何终止请求）", () => {
        const proc = { pid: 999_999, pgid: null, claim: "lineage" as const, createdAt: null };
        expect(killOwnedProc(proc)).toBe(false);
    });

    it("claim=lineage 且创建时刻未知（缺省）⇒ 同样拒绝", () => {
        expect(killOwnedProc({ pid: 999_999, pgid: null, claim: "lineage" })).toBe(false);
    });
});
