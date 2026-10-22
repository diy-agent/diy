// tests/services/local-agent-write.test.ts
// 🎯 `write` 工具（##414）在**注册点**上的行为：工具存在、成功有回执、失败**抛**不 return、审计落盘。
//
// 护栏细节（越界 / 上限 / 目录 / BOM / diff 计数）在 tests/core/file-write.test.ts 钉；
// 这里只验「buildTools 真把它接上了」以及「审计写了一条 file-write」—— 两处都容易漏：
//   · 忘记注册 → 模型看不到工具（不报错，只是永远不用）
//   · 忘记审计 → 事后查不到这次写（##414 契约的一部分）
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, buildTools } from "../../src/main/services/local-agent";
import { auditFile } from "../../src/main/services/agent-audit";

let workDir = "";
let home = "";
let prevHome: string | undefined;

beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "diy-write-test-"));
    home = mkdtempSync(join(tmpdir(), "diy-write-home-"));
    prevHome = process.env["DIY_HOME"];
    process.env["DIY_HOME"] = home;
});

afterAll(() => {
    if (prevHome === undefined) delete process.env["DIY_HOME"];
    else process.env["DIY_HOME"] = prevHome;
    rmSync(workDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

describe("write 工具", () => {
    it("已注册，成功写盘并回 +N/-M", async () => {
        const tools = buildTools(workDir, DEFAULT_LIMITS, "test/task") as any;
        expect(tools.write).toBeTruthy();
        const out: string = await tools.write.execute({ path: "sub/a.txt", content: "x\ny\n" });
        expect(out).toContain("写入 sub/a.txt（+2/-0 行");
        expect(readFileSync(join(workDir, "sub/a.txt"), "utf-8")).toBe("x\ny\n");
    });

    it("失败**抛**（不是 return 一段失败文案）", async () => {
        const tools = buildTools(workDir, DEFAULT_LIMITS, "test/task") as any;
        await expect(tools.write.execute({ path: "../escape.txt", content: "x" })).rejects.toThrow(/越界/);
    });

    it("审计落一条 phase=file-write", async () => {
        const tools = buildTools(workDir, DEFAULT_LIMITS, "test/task") as any;
        await tools.write.execute({ path: "audit.txt", content: "one\ntwo\nthree\n" });
        const fp = auditFile(home);
        expect(existsSync(fp)).toBe(true);
        const rows = readFileSync(fp, "utf-8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        const rec = rows.filter((r) => r.phase === "file-write").at(-1);
        expect(rec).toMatchObject({ taskUri: "test/task", command: "audit.txt", result: "+3/-0" });
    });
});
