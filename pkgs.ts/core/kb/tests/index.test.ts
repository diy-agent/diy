import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    bodyOf,
    moveEntry,
    readFrontmatter,
    renderIndex,
    scanKb,
    sectionsOf,
    writeEntry,
    writeIndex,
} from "../src/index.js";

let root: string;

const put = (rel: string, desc: string, body: string, updated = "2026-11-07"): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, `---\ndesc: ${desc}\nupdated: ${updated}\n---\n\n${body}\n`, "utf-8");
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-"));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("scanKb", () => {
    it("多级目录 + 中文文件名都能收，INDEX.md 不算条目", () => {
        put("rules/通用硬约束.md", "语言 / 验证 / 会话开场", "## 一\n\nx\n\n## 二\n\ny\n");
        put("app/找代码.md", "这功能在哪", "## 找\n\n`rg`\n");
        writeFileSync(join(root, "INDEX.md"), "# 索引\n", "utf-8");

        const { entries, problems } = scanKb(root);
        expect(problems).toEqual([]);
        expect(entries.map((e) => e.path).sort()).toEqual(["app/找代码.md", "rules/通用硬约束.md"]);
        const rules = entries.find((e) => e.path === "rules/通用硬约束.md")!;
        expect(rules.sections).toBe(2);
        expect(rules.updated).toBe("2026-11-07");
    });

    it("根目录散文件 ⇒ kb/root-file（多级目录是铁律）", () => {
        put("散落.md", "不该在这", "## x\n\ny\n");
        const { problems } = scanKb(root);
        expect(problems).toContainEqual(expect.objectContaining({ path: "散落.md", code: "kb/root-file" }));
    });

    it("缺 yaml 头 / 缺 desc / 空正文 各自报码，且不进 entries", () => {
        mkdirSync(join(root, "d"), { recursive: true });
        writeFileSync(join(root, "d/无头.md"), "# 只有正文\n", "utf-8");
        writeFileSync(join(root, "d/无desc.md"), "---\nupdated: 2026-11-07\n---\n\n## x\n\ny\n", "utf-8");
        writeFileSync(join(root, "d/空正文.md"), "---\ndesc: 有头没身\n---\n\n", "utf-8");

        const { entries, problems } = scanKb(root);
        expect(entries).toEqual([]);
        expect(problems.map((p) => p.code).sort()).toEqual(["kb/empty-body", "kb/no-desc", "kb/no-frontmatter"]);
    });

    it("目录不存在 ⇒ 空结果，不抛", () => {
        expect(scanKb(join(root, "nope"))).toEqual({ root: join(root, "nope"), entries: [], problems: [] });
    });

    it("跳过点开头的目录（.git 等）", () => {
        put(".git/x.md", "不该收", "## x\n\ny\n");
        put("d/ok.md", "该收", "## x\n\ny\n");
        expect(scanKb(root).entries.map((e) => e.path)).toEqual(["d/ok.md"]);
    });
});

describe("renderIndex", () => {
    it("按目录分组，组内按路径排序；组标题就是目录名", () => {
        const text = renderIndex(
            [
                { path: "rules/工具偏好.md", desc: "shell / 文件写入", updated: "2026-11-07", sections: 6, bytes: 100 },
                { path: "app/找代码.md", desc: "这功能在哪", updated: "2026-11-06", sections: 3, bytes: 80 },
            ],
            "项目 diy",
        );
        expect(text).toContain("## app/");
        expect(text).toContain("## rules/");
        expect(text).toContain("- `找代码.md` — 这功能在哪（3 节 · 2026-11-06）");
        expect(text.indexOf("## app/")).toBeLessThan(text.indexOf("## rules/"));
        expect(text).toContain("项目 diy");
    });

    it("没有 updated 时不显示那段", () => {
        const text = renderIndex([{ path: "d/x.md", desc: "y", updated: "", sections: 1, bytes: 10 }]);
        expect(text).toContain("- `x.md` — y（1 节）");
        expect(text).not.toContain("· ）");
    });
});

describe("writeEntry —— 路径校验是唯一强制点", () => {
    it("根目录散文件被拒，并提示该放哪", () => {
        expect(() => writeEntry(root, "散落.md", "x")).toThrow(/根目录不许放知识文件/);
        expect(() => writeEntry(root, "散落.md", "x")).toThrow(/rules\/散落\.md/);
    });

    it("多级 + 中文路径可写，父目录自动建", () => {
        const r = writeEntry(root, "rules/通用硬约束.md", "---\ndesc: x\n---\n\n## a\n\nb\n");
        expect(r.bytes).toBeGreaterThan(0);
        expect(r.path).toContain("通用硬约束");
        expect(readFileSync(r.path, "utf-8")).toContain("desc: x");
    });

    it("拒绝 INDEX.md / 非 .md / 越界路径", () => {
        expect(() => writeEntry(root, "INDEX.md", "x")).toThrow(/由工具生成/);
        expect(() => writeEntry(root, "a/b.txt", "x")).toThrow(/\.md 结尾/);
        expect(() => writeEntry(root, "a/../../etc/x.md", "x")).toThrow(/非法路径/);
    });
});

describe("writeIndex", () => {
    it("生成 INDEX.md，有问题的条目不进去", () => {
        put("d/ok.md", "好的", "## x\n\ny\n");
        put("散落.md", "坏的", "## x\n\ny\n");
        const r = writeIndex(root, "项目 diy");
        expect(r.entries).toBe(1);
        expect(r.problems.map((p) => p.code)).toContain("kb/root-file");
        const text = readFileSync(join(root, "INDEX.md"), "utf-8");
        expect(text).toContain("好的");
        expect(text).not.toContain("坏的");
    });
});

describe("moveEntry", () => {
    it("移动后原文件没了、新位置有内容", () => {
        put("d/旧名.md", "说明", "## x\n\ny\n");
        const r = moveEntry(root, "d/旧名.md", "d2/新名.md");
        expect(readFileSync(r.to, "utf-8")).toContain("说明");
        expect(scanKb(root).entries.map((e) => e.path)).toEqual(["d2/新名.md"]);
    });

    it("移到根目录被拒（同一道闸）", () => {
        put("d/x.md", "说明", "## x\n\ny\n");
        expect(() => moveEntry(root, "d/x.md", "x.md")).toThrow(/根目录不许放知识文件/);
    });
});

describe("readFrontmatter / bodyOf / sectionsOf", () => {
    it("折叠与字面标量都收成单行", () => {
        expect(readFrontmatter("---\ndesc: >-\n  甲\n  乙\n---\n")["desc"]).toBe("甲 乙");
        expect(readFrontmatter("---\ndesc: |\n  甲\n  乙\n---\n")["desc"]).toBe("甲 乙");
    });

    it("bodyOf 去掉头；sectionsOf 只数二级标题", () => {
        const text = "---\ndesc: x\n---\n\n## 一\n\n### 子\n\n## 二\n";
        expect(bodyOf(text).trim().startsWith("## 一")).toBe(true);
        expect(sectionsOf(bodyOf(text))).toBe(2);
    });

    it("没有 yaml 头 ⇒ 空对象、bodyOf 原样返回", () => {
        expect(readFrontmatter("# 正文\n")).toEqual({});
        expect(bodyOf("# 正文\n")).toBe("# 正文\n");
    });
});
