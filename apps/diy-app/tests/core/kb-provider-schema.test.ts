// ##519：kb 节「provider 输出」与「wire 契约」必须同形状。
//
// 事故：##521（`63a5a0dc`）把 kb 真源从 `knowledge/facts/*.yaml` 换成 `.diy/knowledge/**/*.md`
// （provider 改输出 `{entries:[{path,desc,sections,scope}]}`），但 `AssembleGlobalsSchema.kb`
// 仍是旧的 `{claims, entries:[{subject,claims,ns}]}`。当时只读全局库且全局库为空 ⇒ provider 返回
// undefined ⇒ 校验整节跳过，谁都没发现；直到 `ce0e1175` 让项目库也被读到（本仓 `.diy/knowledge/`
// 有 68 个 md），`assembleFromProviders` 里的 `AssembleGlobalsSchema.parse` 每次组装都抛 ZodError，
// 一轮 LLM 请求都发不出去（`~/git/world` 没有项目库，所以只有「项目库有货」的任务坏）。
//
// 本用例直接拿**真 provider 的输出**喂**真 schema** —— 任何一边改形状而另一边没跟，这里立刻红。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AssembleGlobalsSchema } from "@diy-agent/context/schema/prompt-schema";
import { kbProvider } from "../../src/main/services/context-providers";

function seedKb(root: string, rel: string, desc: string, sections: string[]): void {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, ["---", `desc: ${desc}`, "---", "", ...sections.flatMap((s) => [`## ${s}`, ""])].join("\n"));
}

describe("kb 节：provider 输出 ⊨ AssembleGlobalsSchema.kb", () => {
    it("项目库有 md 时，provider 的输出能通过 wire 契约校验", () => {
        const tmp = mkdtempSync(join(tmpdir(), "kb-schema-"));
        const home = join(tmp, "home");
        const repo = join(tmp, "repo");
        mkdirSync(home, { recursive: true });
        seedKb(join(repo, ".diy", "knowledge"), "app/cli.md", "CLI 约定", ["入口", "参数"]);
        seedKb(join(repo, ".diy", "knowledge"), "rule/worktree.md", "worktree 规则", ["路径"]);

        // kbProvider 只用到 shared.cwd().cwd —— 其余字段与本用例无关
        const shared = { cwd: () => ({ cwd: repo }) } as unknown as Parameters<typeof kbProvider>[1];
        const value = kbProvider(home, shared).provide();
        expect(value).toBeDefined();

        const parsed = AssembleGlobalsSchema.shape.kb.safeParse(value);
        expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
        const entries = parsed.success ? (parsed.data?.entries ?? []) : [];
        expect(entries.map((e) => e.path)).toEqual(["app/cli.md", "rule/worktree.md"]);
        expect(entries.every((e) => e.scope === "project")).toBe(true);
    });

    it("两层都空时整节缺席（undefined，而不是空对象）", () => {
        const tmp = mkdtempSync(join(tmpdir(), "kb-schema-empty-"));
        const shared = { cwd: () => ({ cwd: join(tmp, "repo") }) } as unknown as Parameters<typeof kbProvider>[1];
        expect(kbProvider(join(tmp, "home"), shared).provide()).toBeUndefined();
    });
});
