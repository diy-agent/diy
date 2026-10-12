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

  it("卡 = `[data-block-id]` 那块**自己**（形状不挂在行头上）", () => {
    // 2026-10-12 用户 R6：「v4 卡片是包含形式的，现在是缩紧单卡」—— 卡必须挂在块上，
    // 才可能把"展开后的正文与子层"包在里面；挂在行头上就只剩一行高。
    // 反面判据：不许再把卡画在 `[data-block-tag="proc-bar"] > [role="button"]` 上。
    const block = skinSelectorBlock();
    expect(block).toMatch(/\[data-skin="card"\] \.diy-chat \[data-block-id\]/);
    expect(block).not.toContain('> [role="button"]');
    expect(preview).toMatch(/data-block-tag="proc-bar"[\s\S]{0,200}data-proc-children/);
  });

  it("小样覆盖两个吃色态（data-failing / data-has-error），否则看不出「只有错误吃色」", () => {
    expect(preview).toContain("data-failing");
    expect(preview).toContain("data-has-error");
  });

  it("折叠条是**一根条**（条里嵌图标）：一个点击区，不拆两件", () => {
    // 2026-10-12 用户 R6：「竖 bar 和折叠箭头是分离的，这样有 2 个点击区」——
    // 拆两件（贴条锚块、图标锚行头）时行头被卡内留白推右 16px，同一行的条与箭头错开一格。
    // 判据：小样里 `[data-row-band]` 必须**包住** `[data-row-handle]`（同嵌套才是同形状）。
    expect(preview).toMatch(/data-row-band[\s\S]{0,120}data-row-handle/);
    // 条整块高 + 图标由一个**常数**定首行居中（两皮肤同一套：见 `.diy-chat` 上的两个变量）
    const block = skinSelectorBlock();
    expect(block).toMatch(/\[data-row-band\][\s\S]{0,200}top: 0;[\s\S]{0,80}bottom: 0;/);
    expect(block).toMatch(/--diy-gut-top/);
  });

  it("小样给出**折叠条列**与**子层容器**（行首留白 / 层级缩进的落点）", () => {
    // 这两条是 2026-10-12 用户口径的落点：小样少了任何一个，设置页里就"看着没变"
    expect(preview).toMatch(/data-row-band/);
    expect(preview).toMatch(/data-row-head/);
    expect(preview).toMatch(/data-proc-children/);
    // 行头必须**真在**块里（与真实 DOM 同嵌套），只写两个属性不算 —— 小样的价值是形状一致
    expect(preview).toMatch(/data-block-id[\s\S]{0,400}data-row-head/);
  });
});
