// tests/core/chat-skin-preview.test.ts — 外观设置里的皮肤小样**不许对不上真规则**
//
// 小样的全部价值 = "显示的差异就是真实的差异"。所以它必须提供 index.css 中
// `[data-skin]` 段每个选择器用到的钩子；漏一个，小样在该皮肤下就悄悄不变，
// 又变回"点了没反应"。这里直接**从 css 反推钩子清单**，而不是让人肉维护。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(__dirname, "../..");
const css = readFileSync(resolve(appDir, "src/renderer_solid/index.css"), "utf8");
const preview = readFileSync(resolve(appDir, "src/renderer_solid/components/ChatSkinPreview.tsx"), "utf8");

/** 取 `[data-skin]` 段（到下一段 `/* ──` 注释为止）的选择器行 */
function skinSelectorBlock(): string {
  const start = css.indexOf('[data-skin="card"]');
  expect(start, "index.css 里找不到 [data-skin] 段").toBeGreaterThan(-1);
  const end = css.indexOf("{", start);
  return css.slice(start, end);
}

describe("皮肤小样（ChatSkinPreview）与 index.css 规则一致", () => {
  it("`[data-skin]` 段用到的每个 data 钩子都在小样里出现", () => {
    const block = skinSelectorBlock();
    const hooks = new Set<string>();
    for (const m of block.matchAll(/\[(data-[a-z-]+)(?:=["'][^"']*["'])?\]/g)) hooks.add(m[1]!);
    expect(hooks.size).toBeGreaterThan(0);
    const missing = [...hooks].filter((h) => !preview.includes(h));
    expect(missing, `小样缺这些钩子（切皮肤时小样不会变）：${missing.join(", ")}`).toEqual([]);
  });

  it("小样带 `diy-chat` scope 类（皮肤变量与规则都挂在它下面）", () => {
    // css 的 [data-skin] 规则全部限定在 `.diy-chat` 内 ⇒ 小样没这个类就一条都不命中
    const block = skinSelectorBlock();
    expect(block).toContain(".diy-chat");
    // 允许类名在 class 字符串里（如 class="diy-chat …"）
    expect(preview).toMatch(/class=[^>]*diy-chat/);
  });

  it("`data-block-tag=\"proc-bar\"` 的命中形状是子元素 `role=\"button\"`（小样同形）", () => {
    // 规则写作 `[data-block-tag="proc-bar"] > [role="button"]`：少一层子元素就整条不命中
    const block = skinSelectorBlock();
    expect(block).toContain('> [role="button"]');
    expect(preview).toMatch(/data-block-tag="proc-bar"/);
    expect(preview).toMatch(/role="button"/);
  });

  it("小样覆盖两个吃色态（data-failing / data-has-error），否则看不出「只有错误吃色」", () => {
    expect(preview).toContain("data-failing");
    expect(preview).toContain("data-has-error");
  });
});
