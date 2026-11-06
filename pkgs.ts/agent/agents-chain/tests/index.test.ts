// 判据逐条来自 diy-app 的实测（原 `prompt-registry.chainOf` 的注释），搬到新包时一并守。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentsChain } from "../src/index.js";

let root: string;

/** 在临时目录里造一个文件（自动建父目录） */
function touch(rel: string, content = `# ${rel}`): string {
    const fp = join(root, rel);
    mkdirSync(join(fp, ".."), { recursive: true });
    writeFileSync(fp, content, "utf-8");
    return fp;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agents-chain-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("agentsChain", () => {
    it("逐层向上收集，外层在前、最深处在后", () => {
        touch("AGENTS.md", "outer");
        touch("a/AGENTS.md", "middle");
        touch("a/b/AGENTS.md", "inner");
        const chain = agentsChain({ appHome: join(root, "nohome"), cwd: join(root, "a/b"), stopAt: root });
        expect(chain.map((c) => c.content)).toEqual(["outer", "middle", "inner"]);
        expect(chain[0]!.scope).toBe(root);
        expect(chain[2]!.path).toBe(join(root, "a/b/AGENTS.md"));
    });

    it("stopAt 之外的目录不爬（cwd 不在上界内 ⇒ 只取自身一层）", () => {
        // root 与 other 是兄弟；stopAt=root 时 other 里的 AGENTS.md 不该被收集
        touch("AGENTS.md", "root-level");
        const other = mkdtempSync(join(tmpdir(), "agents-other-"));
        try {
            writeFileSync(join(other, "AGENTS.md"), "other-level", "utf-8");
            const chain = agentsChain({ appHome: join(root, "nohome"), cwd: other, stopAt: root });
            expect(chain.map((c) => c.content)).toEqual(["other-level"]);
        } finally {
            rmSync(other, { recursive: true, force: true });
        }
    });

    it("应用级规范 unshift 到最前（即使它也在爬升路径上）", () => {
        const appHome = join(root, "diyhome");
        touch("diyhome/AGENTS.md", "app-level");
        touch("a/AGENTS.md", "project");
        const chain = agentsChain({ appHome, cwd: join(root, "a"), stopAt: root });
        expect(chain.map((c) => c.content)).toEqual(["app-level", "project"]);
    });

    it("skipFiles 排除指定文件（任务本体不进规则链）", () => {
        touch("a/AGENTS.md", "rules");
        const taskBody = touch("a/tasks/1/AGENTS.md", "task body");
        const chain = agentsChain({
            appHome: join(root, "nohome"),
            cwd: join(root, "a/tasks/1"),
            stopAt: root,
            skipFiles: [taskBody],
        });
        expect(chain.map((c) => c.content)).toEqual(["rules"]);
    });

    it("appOnly ⇒ 只取应用级，不爬 cwd（cwd 不可信时用）", () => {
        const appHome = join(root, "diyhome");
        touch("diyhome/AGENTS.md", "app-level");
        touch("a/AGENTS.md", "would-be-collected");
        const chain = agentsChain({ appHome, cwd: join(root, "a"), stopAt: root, appOnly: true });
        expect(chain.map((c) => c.content)).toEqual(["app-level"]);
    });

    it("没有 appHome 的 AGENTS.md ⇒ 自然缺席（不是错误）", () => {
        touch("a/AGENTS.md", "project");
        const chain = agentsChain({ appHome: join(root, "no-such-home"), cwd: join(root, "a"), stopAt: root });
        expect(chain.map((c) => c.content)).toEqual(["project"]);
    });

    it("正文 trim（链内容是变量值，不是模版源）", () => {
        const fp = join(root, "a/AGENTS.md");
        mkdirSync(join(root, "a"), { recursive: true });
        writeFileSync(fp, "\n\n  # 带前后空白  \n\n", "utf-8");
        const chain = agentsChain({ appHome: join(root, "nohome"), cwd: join(root, "a"), stopAt: root });
        expect(chain[0]!.content).toBe("# 带前后空白");
    });

    it("一条都没有 ⇒ 空数组（不是 null / 不是抛错）", () => {
        mkdirSync(join(root, "a"), { recursive: true });
        expect(agentsChain({ appHome: join(root, "nohome"), cwd: join(root, "a"), stopAt: root })).toEqual([]);
    });
});
