// tests/services/tools-surface-golden.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 工具面 golden（##519）：`tools` 段进 wire 时排在 **system 之前** ——
//    改一个字节（哪怕只是描述里的一个空格）就把整段前缀缓存作废。
//
// 实测代价（##519）：300k 上下文的会话，工具描述少一个空格 ⇒ cacheRead 8192 / 307134（2.7%），
// 该步全价 ≈ $0.045。而 `toolsBytes` 撞巧相等（952 → 952）时从字节数**看不出任何东西**，
// 两次「抽包重构」的提交说明都写着「文案逐字照搬」，实际各丢了一个字符 —— 靠人自觉守不住。
//
// 判据：真发形状（name + description 逐字节）落快照。不一致就红。
// 要改文案（正当）⇒ 重生成快照，**那个 diff 就是「本次会冷启一次」的签字**：
//   UPDATE_TOOLS_SURFACE=1 npx vitest run tests/services/tools-surface-golden.test.ts
//
// 另一条不变量：工具面**不许依赖 cwd**（依赖了就等于换个目录就冷启，且快照会带临时路径）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTools, DEFAULT_LIMITS } from "../../src/main/services/local-agent";

const FIXTURE = join(__dirname, "..", "fixtures", "tools-surface.golden.json");

/** 真发形状：注册顺序不变的前提下，name + description 的逐字节原文 */
interface ToolSurfaceEntry {
    name: string;
    description: string;
}

function surfaceOf(cwd: string, taskUri: string): ToolSurfaceEntry[] {
    const tools = buildTools(cwd, DEFAULT_LIMITS, taskUri) as Record<
        string,
        { description?: unknown }
    >;
    return Object.entries(tools).map(([name, t]) => ({
        name,
        description: String(t.description ?? ""),
    }));
}

let dirA: string;
let dirB: string;

beforeAll(() => {
    dirA = mkdtempSync(join(tmpdir(), "diy-tools-surface-a-"));
    dirB = mkdtempSync(join(tmpdir(), "diy-tools-surface-b-"));
});

afterAll(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
});

describe("##519 工具面 golden", () => {
    it("工具面不依赖 cwd / 任务（换个目录不许换字节）", () => {
        expect(surfaceOf(dirA, "test/task")).toEqual(surfaceOf(dirB, "test/task"));
    });

    it("真发形状与快照逐字节相同（改了文案就要重生成快照并在提交里写明「会冷启一次」）", () => {
        const actual = surfaceOf(dirA, "test/task");
        const text = JSON.stringify(actual, null, 2) + "\n";
        if (process.env["UPDATE_TOOLS_SURFACE"] === "1") {
            writeFileSync(FIXTURE, text, "utf-8");
            return;
        }
        const golden = readFileSync(FIXTURE, "utf-8");
        // 逐字节比：JSON 文本比对象更好读 diff（多了什么空格一眼看得出）
        expect(text).toBe(golden);
    });
});
