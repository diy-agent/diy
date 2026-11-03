// tests/system-context.test.ts — bot 的简化版系统上下文（##516）
//
// 判据（body）：AGENTS.md 链进 system / facts 摘要进 system / 改文件后**新建**会话生效 /
// 有上限且超了标注 / 组装失败降级不抛。
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsChainOf, buildSystemContext, factsSummaryOf, SYSTEM_CONTEXT_MAX_BYTES } from "../src/index.js";

/** 临时数据根 + 一个「项目」目录（cwd 落在它里面） */
function makeHome(): { home: string; project: string } {
    const home = mkdtempSync(join(tmpdir(), "bot-ctx-"));
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    return { home, project };
}

function writeAgents(dir: string, body: string): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "AGENTS.md");
    writeFileSync(file, body, "utf-8");
    return file;
}

/** 造一份最小可读的 facts 库（claim map 形态；key = `subject#aspect`，同名 key 不能重复） */
function makeKnowledge(dir: string, subjects: Record<string, string>, facts: Record<string, string>): void {
    mkdirSync(join(dir, "facts"), { recursive: true });
    writeFileSync(
        join(dir, "subjects.yaml"),
        `subjects:\n${Object.entries(subjects)
            .map(([key, desc]) => `  ${key}:\n    description: ${desc}`)
            .join("\n")}\n`,
        "utf-8",
    );
    let n = 0;
    const lines: string[] = ["domain: test", "facts:"];
    for (const [claim, value] of Object.entries(facts)) {
        n += 1;
        lines.push(
            `  ${claim}:`,
            `    value: ${value}`,
            `    id: test.${String(n)}`,
            "    review: accepted",
            "    lifecycle: active",
            "    evidence:",
            "      source: user",
            '      at: "~/AGENTS.md:1"',
            '      verifiedAt: "2026-11-03"',
        );
    }
    writeFileSync(join(dir, "facts", "test.yaml"), `${lines.join("\n")}\n`, "utf-8");
}

describe("系统上下文（##516）", () => {
    it("AGENTS.md 链：$DIY_HOME 应用级在前，工作目录逐层在后（外 → 内）", () => {
        const { home, project } = makeHome();
        const appLevel = writeAgents(home, "应用级：一律中文回复");
        const cwdLevel = writeAgents(project, "项目级：改代码先开 worktree");

        const chain = agentsChainOf({ home, cwd: project });
        expect(chain.map((file) => file.path)).toEqual([appLevel, cwdLevel]);
        expect(chain[1]?.scope).toBe(project);
        expect(chain[0]?.content).toContain("一律中文回复");
    });

    it("facts 摘要：主题清单 + 每主题条数（只给条数，不塞正文）", () => {
        const { home, project } = makeHome();
        makeKnowledge(
            join(project, "knowledge"),
            { alpha: "主题甲", beta: "主题乙" },
            { "alpha#default": "v1", "alpha#extra": "v2", "beta#default": "w" },
        );

        const summary = factsSummaryOf({ home, cwd: project });
        expect(summary).toContain("3 条 / 2 个主题");
        expect(summary).toContain("- alpha — 主题甲");
        expect(summary).toContain("- beta — 主题乙");
        expect(summary).not.toContain("v1"); // 正文一律不进索引
    });

    it("只在新会话时组装：整套正文 = 链 + 索引，字节数可控", () => {
        const { home, project } = makeHome();
        writeAgents(home, "应用级规则");
        writeAgents(project, "项目级规则");
        makeKnowledge(join(project, "knowledge"), { alpha: "主题甲" }, { "alpha#default": "v" });

        const result = buildSystemContext({ home, cwd: project });
        expect(result.text).toContain("应用级规则");
        expect(result.text).toContain("项目级规则");
        expect(result.text).toContain("知识库索引");
        expect(result.chain).toHaveLength(2);
        expect(result.omitted).toEqual([]);
        expect(result.bytes).toBe(Buffer.byteLength(result.text, "utf-8"));
        expect(result.bytes).toBeLessThanOrEqual(SYSTEM_CONTEXT_MAX_BYTES);
    });

    it("超上限：按优先级从尾部截断，并标注被省略的部分", () => {
        const { home, project } = makeHome();
        writeAgents(home, "应用级规则".repeat(20)); // ≈ 300 B，先装满第一段
        writeAgents(project, "项目级规则".repeat(200)); // 这一段就超了 → 它和索引一起被砍
        makeKnowledge(join(project, "knowledge"), { alpha: "主题甲" }, { "alpha#default": "v" });

        const result = buildSystemContext({ home, cwd: project, maxBytes: 600 });
        expect(result.bytes).toBeLessThanOrEqual(600 + 200); // 截断说明本身也占字节
        expect(result.omitted.length).toBeGreaterThan(0);
        expect(result.text).toContain("已省略");
        // 优先级：最外层（应用级）必须活下来
        expect(result.text).toContain("应用级规则");
        expect(result.text).not.toContain("- alpha — 主题甲"); // 索引被砍（只剩截断说明里的名字）
    });

    it("组装失败不抛（降级为缺席）", () => {
        const result = buildSystemContext({ home: 123 as unknown as string, cwd: 456 as unknown as string });
        expect(result).toEqual({ text: "", bytes: 0, chain: [], omitted: [] });
    });

    it("什么都没有时返回空串（不产出空壳标题）", () => {
        const { home, project } = makeHome();
        const result = buildSystemContext({ home, cwd: project });
        expect(result.text).toBe("");
        expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
        expect(dirname(project)).toBe(home); // 防呆：夹具没被别处写脏
    });
});
