// tests/core/docs-index.test.ts — 文档索引单元的判据（##5 第 11 轮 B）
//
// 压的是一堆「真文件 + 真 git」的小仓库：日期/状态这些字段全是启发式，构造的空对象测不出来，
// 必须让它们从真文档里长出来（含「git 日期与自述日期不一致」这条实测踩过的坑）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDocsIndex } from "../../src/main/services/docs-index";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpRepo(files: Record<string, string>, opts: { git?: { date: string } } = {}): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "docs-idx-"));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
        const abs = path.join(root, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, text);
    }
    if (opts.git) {
        const git = (args: string[]) =>
            execFileSync("git", args, {
                cwd: root,
                stdio: ["ignore", "ignore", "ignore"],
                env: { ...process.env, GIT_AUTHOR_DATE: opts.git!.date, GIT_COMMITTER_DATE: opts.git!.date },
            });
        git(["init"]);
        git(["add", "-A"]);
        git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "x"]);
    }
    return root;
}

describe("buildDocsIndex", () => {
    it("没有 docs/plans ⇒ null（整节缺席，不是空对象）", () => {
        expect(buildDocsIndex({ root: tmpRepo({ "README.md": "# hi\n" }) })).toBeNull();
    });

    it("标题 / 大小 / 自述日期 / 状态词 都从真文档里抽出来", () => {
        const root = tmpRepo({
            "docs/plans/2026-07-10-acp-research.md":
                "# ACP 调研（2026-07-10 立项）\n\n> 状态：调研完成，未落地\n\n正文\n",
            "docs/plans/instance-modes.md": "# 实例三态：谁来跑、跑哪份数据、看谁的 UI\n\n正文\n",
            "docs/other/x.md": "# 不在缺省根里\n",
        });
        const idx = buildDocsIndex({ root });
        expect(idx?.roots).toEqual(["docs/plans"]);
        const acp = idx?.entries.find((e) => e.path.endsWith("acp-research.md"));
        expect(acp?.title).toBe("ACP 调研"); // 尾部日期括注是元数据，不进标题
        expect(acp?.docDate).toBe("26-07-10");
        expect(acp?.status).toBe("状态：调研完成，未落地");
        expect(acp?.size).toBe(0); // < 1 KB 取整为 0（渲染层写 `0K` 也不是错，是「不够 1K」）
        // 缺省根之外的目录不扫
        expect(idx?.entries.some((e) => e.path.includes("other/"))).toBe(false);
    });

    it("标题超长截断、无 H1 写 `(无 H1)`、抽不到状态就不给", () => {
        const root = tmpRepo({
            "docs/plans/long.md": `# ${"很长的标题".repeat(10)}\n\n正文\n`,
            "docs/plans/none.md": `没有一级标题\n\n${"正文\n".repeat(20)}> 状态：这句在摘要区之外\n`,
        });
        const idx = buildDocsIndex({ root });
        const long = idx?.entries.find((e) => e.path.endsWith("long.md"));
        expect(long?.title.endsWith("…")).toBe(true);
        expect([...(long?.title ?? "")].length).toBeLessThanOrEqual(27);
        const none = idx?.entries.find((e) => e.path.endsWith("none.md"));
        expect(none?.title).toBe("(无 H1)");
        // 「抽不到不许编」：没有状态就是没有这个键
        expect(none?.status).toBeUndefined();
    });

    it("非 git 仓库：touched 缺席，但条目照样出（一个文件坏不许让整节消失）", () => {
        const idx = buildDocsIndex({ root: tmpRepo({ "docs/plans/a.md": "# A\n" }) });
        expect(idx?.entries.length).toBe(1);
        expect(idx?.entries[0]?.touched).toBeUndefined();
    });

    it("git 日期与自述日期**分别**给出（不一致本身就是信号）", () => {
        const root = tmpRepo(
            { "docs/plans/2026-07-10-acp-research.md": "# ACP 调研（2026-07-10 立项）\n\n正文\n" },
            { git: { date: "2026-07-19T12:00:00+0800" } },
        );
        const idx = buildDocsIndex({ root });
        expect(idx?.entries[0]?.docDate).toBe("26-07-10");
        expect(idx?.entries[0]?.touched).toBe("26-07-19");
    });

    it("maxEntries 截断（防某个仓库把 docs 塞成几千篇）", () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 5; i += 1) files[`docs/plans/p${i}.md`] = `# P${i}\n`;
        const idx = buildDocsIndex({ root: tmpRepo(files), maxEntries: 3 });
        expect(idx?.entries.length).toBe(3);
    });

    it("roots 可扩到 docs（覆盖范围写在返回值里，人能看懂这节覆盖到哪）", () => {
        const root = tmpRepo({ "docs/a.md": "# A\n", "docs/plans/b.md": "# B\n" });
        const idx = buildDocsIndex({ root, roots: ["docs"] });
        expect(idx?.roots).toEqual(["docs"]);
        expect(idx?.entries.map((e) => e.path).sort()).toEqual(["docs/a.md", "docs/plans/b.md"]);
    });
});
