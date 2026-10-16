// tests/services/tool-output.test.ts
// 🎯 单条工具输出的投递层截断（##127）—— 头尾保留 + 明确 marker + 原文可 `read` 回取。
//
// 钉住 ##127 的验收：
//   · bash **成功**路径不再裸奔（旧行为：只有报错走 clip，成功全靠 maxBuffer 静默截断）；
//   · bash 成功 / bash 报错 / read 三路径**同一预算**（`TOOL_OUTPUT_MAX_LINES` / `_MAX_BYTES`
//     = `READ_MAX_LINES` / `READ_MAX_BYTES`）；
//   · 截断发生在**投递层**（`toModelOutput`）：`execute` 的返回值仍是全文（ops 原文不动）；
//   · marker 里的原文路径是**绝对路径**，模型可用 `read` 取回被省略的中段。
//
// 无网络、无 LLM、无 Electron —— 纯函数 + 真 bash 级验证。

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTools, DEFAULT_LIMITS, type LocalAgentLimits } from "../../src/main/services/local-agent";
import {
    TOOL_OUTPUT_MAX_BYTES,
    TOOL_OUTPUT_MAX_LINES,
    capToolOutput,
} from "../../src/main/services/tool-output";
import { READ_MAX_BYTES, READ_MAX_LINES, formatReadOutput, readFileWindow } from "../../src/main/core/file-read";

let workDir: string;
const BIG_LINES = 60_000; // ≈ 0.5MB 的「cat 大文件」现场

beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "diy-toolout-test-"));
    writeFileSync(join(workDir, "big.txt"), Array.from({ length: BIG_LINES }, (_, i) => `行 ${i + 1}`).join("\n"), "utf-8");
});
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const limits: LocalAgentLimits = { ...DEFAULT_LIMITS, bashTimeoutMs: 20_000, maxSteps: 1 };

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
/** marker 行（`[... 中间省略 N 行 / X KB，完整输出见 <path> ...]`）——三路径格式一致的判据 */
const markerOf = (text: string) => text.split("\n").find((l) => l.includes("中间省略"));

describe("capToolOutput：不超限即逐字符原样", () => {
    it("短输出：不动一个字，也不落盘", () => {
        const r = capToolOutput("hello\nworld", "call_small");
        expect(r.clipped).toBe(false);
        expect(r.text).toBe("hello\nworld");
        expect(r.origPath).toBeUndefined();
    });

    it("阈值边界：正好 2000 行不裁（触发阈值 = 头 + 尾）", () => {
        const r = capToolOutput(lines(TOOL_OUTPUT_MAX_LINES), "call_edge");
        expect(r.clipped).toBe(false);
    });

    it("超一行即裁：头尾保留 + marker", () => {
        const r = capToolOutput(lines(TOOL_OUTPUT_MAX_LINES + 1), "call_over");
        expect(r.clipped).toBe(true);
        expect(markerOf(r.text)).toContain("中间省略 1 行");
        expect(r.origPath).toBeTruthy();
    });
});

describe("capToolOutput：marker 格式 + 原文可 read 回取", () => {
    const text = lines(10_000);
    const r = capToolOutput(text, "call_big");

    it("marker 写明省略量与原文路径（**绝对路径**：模型只按 cwd 解析相对路径）", () => {
        expect(r.clipped).toBe(true);
        const m = markerOf(r.text)!;
        expect(m).toMatch(/中间省略 \d+ 行 \/ \d+ KB/);
        expect(m).toContain(r.origPath!);
        expect(r.origPath!.startsWith("/")).toBe(true);
    });

    it("原文落盘 = 逐字符全文（不是「落了个裁过的」）", () => {
        expect(readFileSync(r.origPath!, "utf-8")).toBe(text);
    });

    it("被省略的中段可 `read` 取回（绝对路径 + offset 续读）", async () => {
        const tools = buildTools(workDir, limits, "test/task");
        // 中段行（第 5000 行）不在投递文本里，但在原文文件里
        expect(r.text).not.toContain("line 5000");
        const out = await (tools as any).read.execute({ path: r.origPath!, offset: 4998, limit: 5 });
        expect(out).toContain("4998: line 4998");
        expect(out).toContain("5000: line 5000");
    });
});

describe("bash 工具：截断落投递层（toModelOutput），execute 仍返回全文", () => {
    it("cat 大文件：execute 拿全文、toModelOutput 拿头尾 + marker + 路径", async () => {
        const tools = buildTools(workDir, limits, "test/task") as any;
        const out: string = await tools.bash.execute({ command: "cat big.txt" });
        // ① execute 的返回值 = 落进 ops 的**原文**（ops 原文永不动）
        expect(out.split("\n").length).toBe(BIG_LINES);
        expect(out).toContain(`行 ${BIG_LINES}`);
        // ② 发给模型的那一份被收口
        const modelOut: { type: string; value: string } = await tools.bash.toModelOutput({
            toolCallId: "call_cat",
            input: { command: "cat big.txt" },
            output: out,
        });
        expect(modelOut.type).toBe("text");
        expect(modelOut.value).not.toContain(`行 ${Math.floor(BIG_LINES / 2)}`);
        const m = markerOf(modelOut.value)!;
        expect(m).toMatch(/中间省略 \d+ 行 \/ \d+ KB/);
        expect(readFileSync(modelOut.value.match(/(\/\S+\.txt)/)![1]!, "utf-8")).toBe(out);
    });

    it("bash 报错路径与成功路径**同一 marker 格式**（旧行为：报错裁 6000 字符、成功裸奔）", async () => {
        const tools = buildTools(workDir, limits, "test/task") as any;
        const failed: string = await tools.bash.execute({
            command: `for i in $(seq 1 10000); do echo "err $i"; done; exit 3`,
        });
        expect(failed.startsWith("[退出码 3]")).toBe(true);
        const modelOut: { value: string } = await tools.bash.toModelOutput({
            toolCallId: "call_err",
            input: { command: "x" },
            output: failed,
        });
        // 与成功路径同一函数、同一 marker 形状（只有内容不同）
        expect(markerOf(modelOut.value)).toMatch(/中间省略 \d+ 行 \/ \d+ KB/);
        expect(markerOf(modelOut.value)).toContain("/toolout/call_err.txt");
    });
});

describe("三路径同一预算（read 与工具输出层共用一对常量）", () => {
    it("常量同源：工具输出预算 == read 窗口预算", () => {
        expect(TOOL_OUTPUT_MAX_LINES).toBe(READ_MAX_LINES);
        expect(TOOL_OUTPUT_MAX_BYTES).toBe(READ_MAX_BYTES);
    });

    it("read 大文件：同一预算下截断 + 续读入口（与 capToolOutput 的 marker 同语义：都写明「多少没给 + 去哪取」）", async () => {
        const w = await readFileWindow(join(workDir, "big.txt"), "big.txt", {});
        expect(w.lines.length).toBe(READ_MAX_LINES); // 行数预算先到
        expect(w.totalLines).toBe(BIG_LINES); // 总数是真值（续读提示要用）
        const out = formatReadOutput(w, { style: "tool" });
        expect(out).toMatch(/\[已显示 1-2000 行，共 60000 行。续读：offset=2001\]/);
    });
});
