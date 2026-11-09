// ##519：kb 节「provider 输出」与「wire 契约」必须同形状。
//
// 事故：##521 把 kb 真源从 `knowledge/facts/*.yaml` 换成 `.diy/knowledge/**/*.md`（provider 改输出
// `{entries:[{path,desc,sections}]}`），但 `AssembleGlobalsSchema.kb` 仍是旧的
// `{claims, entries:[{subject,claims,ns}]}`。当时全局库为空 → provider 返回 undefined → 校验跳过，
// 谁都没发现；直到 ce0e1175 让项目库也被读到（`.diy/knowledge/` 有 67 个 md），
// `AssembleGlobalsSchema.parse(tree)` 每次组装都抛 ZodError，room/deliver 整轮起不来。
//
// 本用例直接拿真 provider 的输出喂真 schema —— 任何一个改了形状而另一个没跟，这里立刻红。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssembleGlobalsSchema } from "@diy-agent/context/schema/prompt-schema";
import { kbProvider } from "../../src/main/services/context-providers";

function seedKb(root: string, rel: string, desc: string, sections: string[]): void {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
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
        // 形状靠运行时真 schema 验（上面那条 safeParse）；这里读字段走 any，
        // 避免被 `@diy-agent/context` 未重建的旧 `.d.ts` 挡住类型检查
        const entries = (parsed.success ? (parsed.data as unknown as { entries: { path: string; scope: string }[] }).entries : []);
        expect(entries.map((e) => e.path)).toEqual(["app/cli.md", "rule/worktree.md"]);
        expect(entries.every((e) => e.scope === "project")).toBe(true);
    });

    it("两层都空时整节缺席（undefined，而不是空对象）", () => {
        const tmp = mkdtempSync(join(tmpdir(), "kb-schema-empty-"));
        const shared = { cwd: () => ({ cwd: join(tmp, "repo") }) } as unknown as Parameters<typeof kbProvider>[1];
        expect(kbProvider(join(tmp, "home"), shared).provide()).toBeUndefined();
    });
});
