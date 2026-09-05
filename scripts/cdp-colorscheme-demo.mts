/**
 * cdp-colorscheme-demo.mts — 证明「Playwright 一连 CDP 就把主题翻成 light」的机制脚本
 *
 * 结论（源码依据，playwright-core 1.60.0 lib/coreBundle.js）：
 *   1. CRPage 每个 session 初始化时无条件 push updateEmulateMedia()      @45137
 *   2. updateEmulateMedia() 读 page.emulatedMedia()                      @43572
 *   3. emulatedMedia() 里 contextOptions.colorScheme ?? "light" ← 元凶   @20109
 *   4. 最终发出 CDP 命令 Page.setEmulatedMedia({ colorScheme: "light" }) @43576
 *   → Chromium 覆盖 prefers-color-scheme → 渲染层 matchMedia change 触发
 *   → ThemeProvider(theme="system") 重新解析 → html.class = "light"
 *
 * 用法：npm run dev 起来后，从启动日志拿 CDP 地址：
 *   npx tsx scripts/cdp-colorscheme-demo.mts ws://127.0.0.1:65328/devtools/browser/xxx
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require_ = createRequire(import.meta.url);

/**
 * playwright-core 解析：优先仓库本地依赖，回落到 playwright-cli 的全局安装
 * （npm/bun 两个常见全局前缀）。这样演示脚本无需污染 package.json。
 */
function loadChromium(): any {
  const home = homedir();
  const candidates = [
    "playwright-core",
    join(home, ".bun/install/global/node_modules/playwright-core"),
    join(home, ".npm-global/lib/node_modules/playwright-core"),
    "/usr/local/lib/node_modules/playwright-core",
  ];
  for (const spec of candidates) {
    try {
      return require_(spec).chromium;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error("找不到 playwright-core（装一个 playwright-cli 或在仓库里 npm i -D playwright-core）");
}

const { chromium } = { get chromium() { return loadChromium(); } };

const cdpUrl = process.argv[2];
if (!cdpUrl) {
  console.error("用法: npx tsx scripts/cdp-colorscheme-demo.mts <ws://cdp-endpoint>");
  process.exit(1);
}

/** 读取页面当前的 prefers-color-scheme 判定结果与 html class */
async function probe(page: any, label: string) {
  const r = await page.evaluate(() => ({
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    htmlClass: document.documentElement.className,
  }));
  console.log(`  ${label.padEnd(34)} → dark=${r.dark}  class="${r.htmlClass}"`);
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("\n═══ CDP 连接对 prefers-color-scheme 的干扰演示 ═══\n");

  // ── 步骤 A：先用「裸」连接 + 无仿真拿到系统真实外观作为基线 ──
  console.log("[A] 建立 CDP 连接（等价于 playwright-cli attach）");
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  console.log(`    已连接，接管到 page: ${page.url()}`);

  // 关键：connectOverCDP 本身不改仿真；但 Playwright 在 page/session 初始化
  // 阶段就把 context 默认选项（colorScheme 缺省 → "light"）刷下去了。
  await sleep(500);
  const after = await probe(page, "connect 之后（未执行任何测试代码）");

  console.log("\n[B] 显式 no-override，交还给操作系统");
  await page.emulateMedia({ colorScheme: "no-override" });
  await sleep(500);
  const cleared = await probe(page, "no-override 之后");

  console.log("\n[C] 显式 dark，模拟 CI 里期望的表现");
  await page.emulateMedia({ colorScheme: "dark" });
  await sleep(500);
  const forced = await probe(page, "colorScheme:'dark' 之后");

  console.log("\n[D] 不传 colorScheme（Playwright 文档默认 = light）");
  await page.emulateMedia({ colorScheme: "light" });
  await sleep(500);
  const back = await probe(page, "回滚为 light");

  console.log("\n[断言]");
  console.log(`  仿真被 Playwright 单方面置为 light : ${after.dark === false ? "✔ 成立" : "✘ 未复现"}`);
  console.log(`  no-override 交还系统 → 恢复 dark   : ${cleared.dark === true ? "✔ 成立" : "✘ 未复现"}`);
  console.log(`  显式 dark 可稳定锁住               : ${forced.dark === true ? "✔ 成立" : "✘ 未复现"}`);
  console.log(`  light 可再次翻白（干扰可重现）      : ${back.dark === false ? "✔ 成立" : "✘ 未复现"}`);

  console.log("\n[E] 收尾：把 app 留在 dark，断开连接");
  await page.emulateMedia({ colorScheme: "dark" });
  await browser.close(); // 注意：只断开 CDP，不会关掉 Electron

  console.log("\n说明：");
  console.log("  · 这不是 CDP 协议本身的副作用，是 Playwright BrowserContext 的默认值");
  console.log("    （colorScheme: 'light'）在 page session 初始化时被主动刷进 Chromium。");
  console.log("  · detach 后仿真仍留在 target 上，所以要显式 no-override / dark 复位。");
  console.log("  · app 侧根治：ThemeProvider 传 defaultTheme=\"dark\"，主题即不再依赖\n    prefers-color-scheme，任何自动化工具都翻不动它。\n");
})();
