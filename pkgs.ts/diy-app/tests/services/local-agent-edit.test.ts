// tests/services/local-agent-edit.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 内置 edit 工具意图验证（##415）—— 装配层（buildTools）这一端
//
// 内核语义在 tests/core/file-edit.test.ts；这里只钉「接进工具之后」的契约：
//   · 注册名 / 参数名 = edit(path, edits[])
//   · 成功返回「摘要 + unified patch」，并真的写盘
//   · 失败**抛**（→ SDK 发 tool-error → status:"error"，不能 return 失败字符串）
//   · 越界路径由工具层拦成 fs/path-escape
//   · 审计留痕（file-edit-start / file-edit-end）
//
// 无网络、无 LLM、无 Electron
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTools, DEFAULT_LIMITS } from "../../src/main/services/local-agent";
import { auditFile, tailAudit } from "../../src/main/services/agent-audit";

let workDir: string;
let outsideDir: string;

const limits = { ...DEFAULT_LIMITS, bashTimeoutMs: 5_000, maxSteps: 1 };

beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "diy-edit-test-"));
    outsideDir = mkdtempSync(join(tmpdir(), "diy-edit-outside-"));
});

afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
});

describe("edit 工具 — 装配层契约", () => {
    it("成功：写盘 + 返回摘要与 unified patch", async () => {
        const p = join(workDir, "ok.ts");
        writeFileSync(p, "const a = 1;\nconst b = 2;\n", "utf-8");
        const tools = buildTools(workDir, limits, "test/task") as any;
        const out: string = await tools.edit.execute({
            path: "ok.ts",
            edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
        });
        expect(readFileSync(p, "utf-8")).toBe("const a = 1;\nconst b = 3;\n");
        expect(out).toContain("已替换 ok.ts 的 1 处");
        expect(out).toContain("--- a/ok.ts");
        expect(out).toContain("+++ b/ok.ts");
        expect(out).toContain("+const b = 3;");
        expect(out).toContain("-const b = 2;");
    });

    it("唯一匹配失败：抛出（不是返回失败字符串）", async () => {
        const p = join(workDir, "miss.ts");
        writeFileSync(p, "x\n", "utf-8");
        const tools = buildTools(workDir, limits, "test/task") as any;
        await expect(tools.edit.execute({ path: "miss.ts", edits: [{ oldText: "nope", newText: "y" }] })).rejects.toMatchObject({
            code: "fs/no-match",
        });
        expect(readFileSync(p, "utf-8")).toBe("x\n");
    });

    it("越界路径：fs/path-escape", async () => {
        const outside = join(outsideDir, "secret.txt");
        writeFileSync(outside, "secret\n", "utf-8");
        const tools = buildTools(workDir, limits, "test/task") as any;
        await expect(
            tools.edit.execute({ path: outside, edits: [{ oldText: "secret", newText: "x" }] }),
        ).rejects.toMatchObject({ code: "fs/path-escape" });
        expect(readFileSync(outside, "utf-8")).toBe("secret\n");
    });

    it("审计：写前 / 写后各一条（带路径）", async () => {
        const p = join(workDir, "audit.ts");
        writeFileSync(p, "a\n", "utf-8");
        const tools = buildTools(workDir, limits, "test/task") as any;
        await tools.edit.execute({ path: "audit.ts", edits: [{ oldText: "a", newText: "b" }] });
        const rows = tailAudit(process.env["DIY_HOME"] as string, 200).filter(
            (r) => r.phase === "file-edit-start" || r.phase === "file-edit-end",
        );
        const start = rows.filter((r) => r.phase === "file-edit-start").at(-1);
        const end = rows.filter((r) => r.phase === "file-edit-end").at(-1);
        expect(start?.path).toBe("audit.ts");
        expect(end?.path).toBe("audit.ts");
        expect(readFileSync(auditFile(process.env["DIY_HOME"] as string), "utf-8")).toContain("file-edit-end");
    });
});
