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

/**
 * 取 `[data-skin]` 段的**全部**选择器（从第一处 `[data-skin=` 到文件末尾）。
 *
 * 为什么不是"到第一个 `{` 为止"（旧版写法）：那样只扫到第一条规则的选择器组，
 * 后面新加的规则（子层容器、手柄列…）用了什么钩子**一律看不见** —— 小样漏钩子时
 * 测试照绿，等于这道闸门对着新规则失效。皮肤段是 index.css 的**最后一段**，
 * 故直接切到 EOF；它一旦不再是最后一段，这里会连带失败（比静默漏检好）。
 */
function skinSelectorBlock(): string {
  const start = css.indexOf('[data-skin="card"]');
  expect(start, "index.css 里找不到 [data-skin] 段").toBeGreaterThan(-1);
  return css.slice(start);
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

  it("贴条 `data-row-band` 在**块级**（行头之外），图标 `data-row-handle` 仍在行头里", () => {
    // 折叠条 = 两件东西两个锚点（2026-10-12 用户口径：贴条整块高（v3）、图标首行居中）：
    // 贴条塞进行头 → 被框在行头那一行里，大块上就不是"整个块高度"了
    expect(preview).toMatch(/data-block-tag="proc-bar"[\s\S]{0,120}data-row-band/);
    // 图标必须仍在行头里（行头单行 ⇒ 行头居中 == 首行居中）
    expect(preview).toMatch(/data-row-head[\s\S]{0,400}data-row-handle/);
  });

  it("小样给出**手柄列**与**子层容器**（竖列折叠手柄 / card 皮肤不缩进的落点）", () => {
    // 这两条是 2026-10-12 用户口径的落点：小样少了任何一个，设置页里就"看着没变"
    expect(preview).toMatch(/data-row-handle/);
    expect(preview).toMatch(/data-row-head/);
    expect(preview).toMatch(/data-proc-children/);
    // 手柄必须**真在**行头里（与真实 DOM 同嵌套：`[data-row-head] > [data-row-handle]`），
    // 只写两个属性不算 —— 小样的价值是形状一致
    expect(preview).toMatch(/data-row-head[\s\S]{0,400}data-row-handle/);
  });
});
