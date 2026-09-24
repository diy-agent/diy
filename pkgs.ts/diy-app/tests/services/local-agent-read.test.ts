// tests/services/local-agent-read.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 read 工具路径解析意图验证
//
// 覆盖 bug #149：read 工具对绝对路径错误拼接项目目录（cwd）
//   join(cwd, "/abs/path") → "/cwd/abs/path"（ENOENT）
//   修复：path.resolve(cwd, filePath) — 绝对路径直接返回
//
// 无网络、无 LLM、无 Electron — 纯函数级验证
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTools } from "../../src/main/services/local-agent";
import { DEFAULT_LIMITS, type LocalAgentLimits } from "../../src/main/services/local-agent";

let workDir: string;   // 模拟 cwd（项目目录）
let outsideDir: string; // cwd 之外的绝对路径

beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "diy-read-test-"));
    outsideDir = mkdtempSync(join(tmpdir(), "diy-read-outside-"));
    writeFileSync(join(workDir, "relative.txt"), "relative-ok", "utf-8");
    writeFileSync(join(outsideDir, "absolute.txt"), "absolute-ok", "utf-8");
});

afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
});

/** 构造一个最小 limits（只填 read 需要的字段） */
const limits: LocalAgentLimits = {
    ...DEFAULT_LIMITS,
    outputClipChars: 10_000,
    bashTimeoutMs: 5_000,
    maxSteps: 1,
    maxTurns: 1,
};

describe("read 工具 — 路径解析", () => {
    it("相对路径：拼 cwd 后可读", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        const result = await (tools as any).read.execute({ path: "relative.txt" });
        expect(result).toBe("relative-ok");
    });

    it("绝对路径（项目外）：不拼 cwd，直接读取", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        const absPath = join(outsideDir, "absolute.txt");
        const result = await (tools as any).read.execute({ path: absPath });
        expect(result).toBe("absolute-ok");
    });

    it("绝对路径（项目外）：不包含 cwd 前缀", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        const absPath = join(outsideDir, "absolute.txt");
        const result = await (tools as any).read.execute({ path: absPath });
        // 修复前会返回 "[读取失败] ENOENT: ... /tmp/diy-read-test-xxx//tmp/diy-read-outside-xxx/..."
        expect(result).not.toContain("[读取失败]");
        expect(result).not.toContain("ENOENT");
    });

    it("不存在的文件：返回读取失败而非崩溃", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        const result = await (tools as any).read.execute({ path: "nonexistent.txt" });
        expect(result).toContain("[读取失败]");
        expect(result).toContain("ENOENT");
    });
});
