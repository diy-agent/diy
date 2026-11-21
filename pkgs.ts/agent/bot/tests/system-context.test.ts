// tests/system-context.test.ts — bot 的简化版系统上下文（##516）
//
// 判据（body）：AGENTS.md 链进 system / 改文件后**新建**会话生效 /
// 有上限且超了标注 / 组装失败降级不抛。
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsChainOf, buildSystemContext, SYSTEM_CONTEXT_MAX_BYTES } from "../src/index.js";

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

    it("只在新会话时组装：整套正文 = 链 + 索引，字节数可控", () => {
        const { home, project } = makeHome();
        writeAgents(home, "应用级规则");
        writeAgents(project, "项目级规则");
        const result = buildSystemContext({ home, cwd: project });
        expect(result.text).toContain("应用级规则");
        expect(result.text).toContain("项目级规则");
        expect(result.chain).toHaveLength(2);
        expect(result.omitted).toEqual([]);
        expect(result.bytes).toBe(Buffer.byteLength(result.text, "utf-8"));
        expect(result.bytes).toBeLessThanOrEqual(SYSTEM_CONTEXT_MAX_BYTES);
    });

    it("超上限：按优先级从尾部截断，并标注被省略的部分", () => {
        const { home, project } = makeHome();
        writeAgents(home, "应用级规则".repeat(20)); // ≈ 300 B，先装满第一段
        writeAgents(project, "项目级规则".repeat(200)); // 这一段就超了 → 它和索引一起被砍
        const result = buildSystemContext({ home, cwd: project, maxBytes: 600 });
        expect(result.bytes).toBeLessThanOrEqual(600 + 200); // 截断说明本身也占字节
        expect(result.omitted.length).toBeGreaterThan(0);
        expect(result.text).toContain("已省略");
        // 优先级：最外层（应用级）必须活下来
        expect(result.text).toContain("应用级规则");
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
