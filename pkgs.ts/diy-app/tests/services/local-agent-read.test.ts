// tests/services/local-agent-read.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 内置 read 工具意图验证
//
// 覆盖两块：
//   #149 路径解析：绝对路径曾被错误拼接项目目录（cwd）→ "/cwd/abs/path"（ENOENT）
//        修复：path.resolve(cwd, filePath) — 绝对路径直接返回
//   #156 截断语义：曾用 clip(s, 6000) 取头尾丢中间；现接 core/file-read 的行窗口，
//        输出带行号 + offset 续读入口（与 `diy tool read` 同源）
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
    readMaxBytes: 50 * 1024,
    bashTimeoutMs: 5_000,
    maxSteps: 1,
};

/** 从工具输出里剥出行号与尾部提示，取纯内容 */
function bodyOf(out: string): string {
    return out
        .split("\n")
        .filter((l) => /^\d+: /.test(l))
        .map((l) => l.replace(/^\d+: /, ""))
        .join("\n");
}

describe("read 工具 — 路径解析（#149）", () => {
    it("相对路径：拼 cwd 后可读", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        const result = await (tools as any).read.execute({ path: "relative.txt" });
        expect(bodyOf(result)).toBe("relative-ok");
    });

    it("绝对路径（项目外）：不拼 cwd，直接读取", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        const absPath = join(outsideDir, "absolute.txt");
        const result = await (tools as any).read.execute({ path: absPath });
        expect(bodyOf(result)).toBe("absolute-ok");
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

describe("read 工具 — 行窗口与续读（#156）", () => {
    it("输出带文件真实行号 + 文件结束提示", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        const result = await (tools as any).read.execute({ path: "relative.txt" });
        expect(result).toContain("1: relative-ok");
        expect(result).toContain("[文件结束，共 1 行]");
    });

    it("limit 收窄：尾部给出 offset 续读入口（旧 clip 没有这个出口）", async () => {
        const p = join(workDir, "many.txt");
        writeFileSync(p, Array.from({ length: 50 }, (_, i) => `row${i + 1}`).join("\n") + "\n", "utf-8");
        const tools = buildTools(workDir, limits, "test/task");
        const result = await (tools as any).read.execute({ path: "many.txt", limit: 10 });
        expect(result).toContain("10: row10");
        expect(result).not.toContain("11: row11");
        expect(result).toContain("[已显示 1-10 行，共 50 行。续读：offset=11]");
    });

    it("offset 续读：接上一段，行号连续", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        const result = await (tools as any).read.execute({ path: "many.txt", offset: 11, limit: 5 });
        expect(result).toContain("11: row11");
        expect(result).toContain("15: row15");
    });

    it("offset 越界：返回读取失败而非崩溃", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        const result = await (tools as any).read.execute({ path: "many.txt", offset: 9999 });
        expect(result).toContain("[读取失败]");
        expect(result).toContain("超出文件范围");
    });

    it("超长单行原样返回（不砍半行 —— jsonl 一行一条记录）", async () => {
        const p = join(workDir, "long.txt");
        const line = "z".repeat(5000);
        writeFileSync(p, line + "\n", "utf-8");
        const tools = buildTools(workDir, limits, "test/task");
        const result = await (tools as any).read.execute({ path: "long.txt" });
        expect(bodyOf(result)).toBe(line);
    });

    it("readMaxBytes 生效：调小后按预算截断并给出续读入口", async () => {
        const tools = buildTools(workDir, { ...limits, readMaxBytes: 40 }, "test/task");
        const result = await (tools as any).read.execute({ path: "many.txt" });
        expect(result).toContain("已达");
        expect(result).toMatch(/续读：offset=\d+/);
    });
});
