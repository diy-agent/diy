// tests/cli.intent.ui-chat-md.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 chat 正文「Markdown 原文 / 渲染」两态切换（回归 168，入口形态见 ##348 ④）
//
// 需求：聊天 view 顶栏有一个开关切正文的显示方式 —— 原文态按纯文本显示（能看清 markdown
// 源码），渲染态回到富文本（同一页面，无需切换/刷新）。
// 形态（##348 ④）：**单个 `<>` 图标按钮**两态切换（VSCode「切换源码」范式）——
// 原先并排两个按钮（MD 原文 / MD 渲染）像两个动作，其实是同一开关的两面。
// 态的表达：`aria-pressed`（true = 原文态）+ tooltip 写「点一下会去哪」。
//
// 验证分两层：
//   1. 状态层：点击写回 localStorage（diy_chat_md=0/1），按钮态跟得上
//   2. DOM 层：正文 h2 真消失 / 真重现（CDP 原生鼠标事件，命中测试与真人同路径）
//
// 数据构造：直写 ops.jsonl（UI 重放的权威输入）。文件名 key 由产品代码 opsFile 生成，
// 目录换成隔离实例自己的 HOME —— 测试进程与 Electron 是两个 DIY_HOME（setup.ts 隔离）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { basename, dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/services/local-agent";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uri = "";

/** 切换按钮的唯一稳定钩子（皮肤/文案可改，这个不改） */
const TOGGLE = '[data-testid="chat-md-toggle"]';

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(electron.cdpUrl, async () => {
    const r = await fx.sh.getJson("./diy.sh ui inspect");
    return (r.data as any)?.data?.tree as A11yNode | undefined;
  });
});

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

/** 正文 h2 文本（markdown 渲染态的证据；不存在 = 空串） */
const h2Text = () =>
  ui.query<string>("document.querySelector('.markdown-body h2')?.textContent ?? ''");
/** markdown 容器是否存在（原文态应整体消失） */
const hasMarkdownBody = () => ui.query<boolean>("!!document.querySelector('.markdown-body')");
/** 字面 markdown 源码是否可见（原文态的证据） */
const showsRawHeading = () => ui.query<boolean>("document.body.textContent.includes('## 结论标题')");
/** 开关的当前态：data-md=1 渲染 / 0 原文；aria-pressed 表达「原文态」 */
const toggleState = () =>
  ui.query<string>(
    `(() => { const b = document.querySelector('${TOGGLE}');
      return b ? JSON.stringify({ md: b.getAttribute('data-md'), pressed: b.getAttribute('aria-pressed'), tip: b.getAttribute('data-tip') }) : 'MISSING'; })()`,
  );

describe("chat 正文：Markdown 原文 / 渲染两态切换", () => {
  it("setup: 造任务 + 一段带 markdown 的会话落进 ops.jsonl", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/md --label MD`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create "MD 切换验证" ${pid}`);
    uri = String((t.data as any)?.data?.uri);
    expect(uri).toMatch(/^projects\/.+\/tasks\/.+$/);

    const file = join(fx.HOME, "local", basename(opsFile(uri)));
    mkdirSync(dirname(file), { recursive: true });
    const ops = [
      { op: "start", id: "t1", kind: "turn", meta: { model: "test" } },
      { op: "start", id: "u1", kind: "text", parent: "t1", meta: { role: "user" } },
      { op: "delta", id: "u1", fields: { content: "请写一段 markdown" } },
      { op: "stop", id: "u1" },
      { op: "start", id: "a1", kind: "text", parent: "t1", meta: { role: "assistant" } },
      { op: "delta", id: "a1", fields: { content: "## 结论标题\n\n这段是**加粗**正文。\n" } },
      { op: "stop", id: "a1" },
      { op: "stop", id: "t1" },
    ];
    writeFileSync(file, ops.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");
  });

  it("打开任务页：顶栏只有一个 `<>` 切换按钮（不是并排两个），默认渲染态正文出 h2", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    // 入口上屏：这个按钮带 aria-label，会进 a11y 树（也顺带证明它真的可见可点）
    const text = await waitUntil(
      async () => {
        const res = await fx.sh.getJson("./diy.sh ui inspect");
        const acc: string[] = [];
        const walk = (n: any) => {
          if (n?.text) acc.push(String(n.text));
          for (const c of n?.children ?? []) walk(c);
        };
        walk((res.data as any)?.data?.tree);
        return acc.join("\n");
      },
      (t) => t.includes("Markdown 显示方式"),
      { label: "chat 顶栏 MD 切换按钮上屏" },
    );
    expect(text).toContain("Markdown 显示方式");

    // 单按钮：旧的两个并排按钮不许再出现（这就是 ④ 的验收口径）
    expect(await ui.query<number>(`document.querySelectorAll('${TOGGLE}').length`)).toBe(1);
    expect(
      await ui.query<boolean>(`document.body.textContent.includes('MD 原文')`),
    ).toBe(false);

    expect(await waitUntil(h2Text, (t) => t === "结论标题", { label: "h2 渲染出来" })).toBe("结论标题");
    const st = JSON.parse((await toggleState()) as string) as { md: string; pressed: string; tip: string };
    expect(st.md).toBe("1");
    expect(st.pressed).toBe("false");
    expect(st.tip).toContain("原文"); // tooltip 写「点一下会去哪」

    // 位置：按钮在 view 顶栏的右上角区域（用户认的入口就在那儿）。
    // 只断言"在右半区"而不写死像素：顶栏宽度随 area 布局变（用户可拖线）。
    const where = await ui.query<{ left: number; right: number; vw: number; w: number }>(
      `(() => {
         const btn = document.querySelector('${TOGGLE}');
         const r = btn.getBoundingClientRect();
         return { left: r.left, right: r.right, vw: window.innerWidth, w: r.width };
       })()`,
    );
    expect(where.left).toBeGreaterThan(where.vw / 2);
    expect(where.right).toBeLessThanOrEqual(where.vw);
    // 图标按钮：比旧的双按钮窄（省下的就是 ④ 要的那一格）
    expect(where.w).toBeLessThan(60);
  });

  it("点一下 → 正文立即变纯文本（h2 消失、源码可见）+ 状态写回 localStorage + 按钮按下", async () => {
    await ui.clickSelector(TOGGLE);
    expect(await waitUntil(hasMarkdownBody, (v) => v === false, { label: "markdown 容器退场" })).toBe(false);
    expect(await showsRawHeading()).toBe(true);
    expect(await ui.query<string>("localStorage.getItem('diy_chat_md')")).toBe("0");
    const st = JSON.parse((await toggleState()) as string) as { md: string; pressed: string; tip: string };
    expect(st.md).toBe("0");
    expect(st.pressed).toBe("true"); // 原文态 = 按下
    expect(st.tip).toContain("渲染");
  });

  it("再点一下 → 同一页面立即恢复富文本（不回退、不重挂载）", async () => {
    await ui.clickSelector(TOGGLE);
    expect(await waitUntil(h2Text, (t) => t === "结论标题", { label: "h2 回来" })).toBe("结论标题");
    expect(await ui.query<string>("localStorage.getItem('diy_chat_md')")).toBe("1");
    // 仍停留在本任务的执行页（切换没有把页面搞掉）
    const list = (await fx.sh.getJson("./diy.sh ui tab list")) as { data: any };
    expect((list.data as any)?.data?.active).toBe(`task-run:${uri}`);
  });
});
