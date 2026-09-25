// tests/cli.intent.ui-tabs.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 任务 tab（动态页面）的**行为**契约 —— 走真实 renderer
//
// 语义（见 133）：打开 = 「我现在要做这个任务」，关闭 = 「暂时不理会」，
// **与任务状态无关**。等同浏览器/编辑器开 tab。
// 另含 137 的回归：非法 page 不得把主区打成白屏。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let uri = "";

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
});

afterAll(async () => {
  await fx?.electron?.stop();
});

/** 已打开的 tab */
async function tabs(): Promise<{ opened: string[]; active: string }> {
  const r = await fx.sh.getJson("./diy.sh ui tab list");
  return (r.data as any)?.data ?? { opened: [], active: "" };
}

/** a11y 树文本（ui inspect 才是 DOM 树；ui tree 是任务树，别混） */
function collectText(nodes: any[], acc: string[] = []): string[] {
  for (const n of nodes ?? []) {
    if (n?.text) acc.push(String(n.text));
    if (n?.children) collectText(n.children, acc);
  }
  return acc;
}


/** 在 a11y 树里按谓词找节点（拿 rect 用；`ui inspect` 的输出带坐标） */
function findNodeRect(nodes: any, pred: (n: any) => boolean): any | undefined {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  for (const n of list) {
    if (!n) continue;
    if (pred(n)) return n.rect;
    const hit = findNodeRect(n.children, pred);
    if (hit) return hit;
  }
  return undefined;
}

async function a11yText(): Promise<string> {
  const res = await fx.sh.getJson("./diy.sh ui inspect");
  return collectText([(res.data as any)?.data?.tree]).join("\n");
}

describe("任务 tab —— 打开 / 聚焦 / 关闭", () => {
  it("setup: 造任务", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/tabs --label Tabs`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 任务tab验证 ${pid}`);
    uri = String((t.data as any)?.data?.uri);
    expect(uri).toMatch(/^projects\/.+\/tasks\/.+$/);
  });

  it("初始没有打开的 tab（回任务树）", async () => {
    await fx.sh.getJson("./diy.sh ui page navigate task");
    expect((await tabs()).active).toBe("");
  });

  it("打开 → 出现在列表且成为 active；任务执行页真的上屏", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    const KEY = `task-run:${uri}`;
    expect(await waitUntil(
      async () => JSON.stringify(await tabs()),
      (s) => s.includes(KEY),
      { label: "tab 出现在列表" },
    )).toContain(KEY);
    expect((await tabs()).active).toBe(KEY);

    // 渲染验证：执行页有 page 菜单条（每个 area 一个布局按钮）+ 左栏任务详情 + 中栏输入框
    const text = await waitUntil(a11yText, (s) => s.includes("任务详情") && s.includes("① left"), {
      label: "任务执行页上屏",
    });
    expect(text).toContain("🪟 提示词"); // 子页面入口
    // 布局按钮：**只给有 view 的 area**（right / bottom 还是空的，按钮点了没反应）
    expect(text).toContain("① left");
    expect(text).toContain("② center");
    expect(text).not.toContain("right");
    expect(text).not.toContain("bottom");
    expect(text).toContain("任务详情");
    expect(text).toContain("发送"); // chat 在
    // 详情不再有 tab（会话已移到 chat area）
    expect(text).not.toContain("🧪 Local");
  });

  it("重复打开同一任务 → 聚焦已有，不新开", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    const t = await tabs();
    expect(t.opened).toEqual([`task-run:${uri}`]);
  });

  it("关闭 → 从列表移除并回到任务树（此时无 tab 可选）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab close task-run:${uri}`);
    const t = await tabs();
    expect(t.opened).toEqual([]);
    expect(t.active).toBe("");
  });
});

describe("侧栏：高亮唯一 + 收缩/展开结构一致", () => {
  it("任务执行页时「任务管理」不高亮（高亮只落在具体 tab 上）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    const text = await waitUntil(a11yText, (s) => s.includes("任务详情"), { label: "执行页就位" });
    // 侧栏项都在（且没有重复的「任务树」行 —— 它曾被冗余地塞在「任务」下面）
    expect(text).toContain("任务管理");
    expect(text).toContain("LLM");
    expect(text).toContain("设置");
  });
});

describe("非法 page 不得白屏（回归 137）", () => {
  it("navigate 到不存在的 page → 主区内容不变", async () => {
    await fx.sh.getJson("./diy.sh ui page navigate task");
    const before = await waitUntil(a11yText, (s) => s.includes("创建项目"), { label: "任务树就位" });
    // "chat" 曾在 NavPage 字面量里但无对应视图分支 → 整页空白
    await fx.sh.getJson("./diy.sh ui page navigate chat");
    await fx.sh.getJson("./diy.sh ui page navigate 不存在的页面");
    const after = await a11yText();
    expect(after).toContain("创建项目"); // 仍在任务树，未被清空
    expect(collectText([null]).length).toBe(0);
    // 主区节点数不得塌成 0（侧面印证：导航项之外的文本仍在）
    expect(before.includes("创建项目")).toBe(true);
  });
});

describe("提示词页 = 子页面（打开 / 生命周期）", () => {
  it("任务执行页有子页面入口；打开后 tab 列表出现 lab:<uri> 且调参 UI 上屏", async () => {
    // ① 任务执行页：菜单条上有进入子页面的入口
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    const taskRun = await waitUntil(a11yText, (s) => s.includes("🪟 提示词"), { label: "子页面入口" });
    expect(taskRun).toContain("任务详情"); // 中心是 chat，左栏是详情

    // ② 打开子页面 → tab 列表出现 lab:<uri>，内容换成提示词调参（中心 = 编辑器）
    await fx.sh.getJson(`./diy.sh ui tab open lab:${uri}`);
    expect(await waitUntil(
      async () => JSON.stringify(await tabs()),
      (s) => s.includes(`lab:${uri}`),
      { label: "子页面 tab 出现在列表" },
    )).toContain(`lab:${uri}`);

    const lab = await waitUntil(a11yText, (s) => s.includes("模板") && s.includes("模版结构树"), {
      label: "提示词页上屏",
    });
    expect(lab).toContain("⟳ 刷新");
    expect(lab).toContain("① left"); // 本 page 的 area 开合按钮
    expect(lab).not.toContain("任务详情"); // 不是任务执行页
  });

  it("关父 tab → 子页面一并关闭（生命周期挂在父上）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open lab:${uri}`);
    const before = await tabs();
    expect(before.opened).toContain(`lab:${uri}`);

    await fx.sh.getJson(`./diy.sh ui tab close task-run:${uri}`);
    const after = await tabs();
    expect(after.opened.filter((k) => k.startsWith("lab:"))).toEqual([]); // 子页面连带关闭
    expect(after.opened).not.toContain(`task-run:${uri}`);
  });
});

// ═══════════════════════════════════════════════════════════════
// view 级隐藏/显示（ui view set）—— 与 viewarea.set / view.expand 是三件事
// ═══════════════════════════════════════════════════════════════

describe("ui view set —— view 级隐藏/显示", () => {
  it("任务执行页：空 area（right / bottom）不该有开合按钮", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    const s = await waitUntil(a11yText, (t) => t.includes("任务详情"), { label: "任务执行页上屏" });
    expect(s).toContain("① left");
    expect(s).toContain("② center");
    // right / bottom 在本 page 没有任何 view → 按钮点了没反应，不该出现
    expect(s).not.toContain("right");
    expect(s).not.toContain("bottom");
  });

  it("隐藏 chat.local → 其 area 空掉，按钮与内容一并消失；显示 → 原样回来", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await waitUntil(a11yText, (t) => t.includes("② center"), { label: "隐藏前的三栏" });

    await fx.sh.getJson(`./diy.sh ui view set chat.local closed --ctx ${uri}`);
    const hidden = await waitUntil(a11yText, (t) => !t.includes("② center"), {
      label: "center 空掉",
    });
    expect(hidden).toContain("① left"); // 左侧详情仍在
    expect(hidden).toContain("任务详情");

    await fx.sh.getJson(`./diy.sh ui view set chat.local open --ctx ${uri}`);
    const back = await waitUntil(a11yText, (t) => t.includes("② center"), { label: "恢复显示" });
    expect(back).toContain("① left");
  });

  it("拒绝非法寻址（未知 view / view 不含该 page / context 型缺 ctx）", async () => {
    await fx.sh.assertSession(`
      $! ./diy.sh ui view set ghost.view closed --ctx ${uri}
      *未知 view*
    `);
    await fx.sh.assertSession(`
      $! ./diy.sh ui view set chat.local closed --page settings --ctx ${uri}
      *不允许放在*
    `);
    await fx.sh.assertSession(`
      $! ./diy.sh ui view set chat.local closed
      *必须给上下文键*
    `);
  });
});

// ═══════════════════════════════════════════════════════════════
// ui layout —— CLI 操纵 UI 状态（第一种测试能力的入口）
//   验证链：CLI 写布局 → 有效布局变 → **界面上真的变**（不是只改了内存）
// ═══════════════════════════════════════════════════════════════

describe("ui layout —— 读 / 写 / 复位", () => {
  async function layout(page = "task-run") {
    const r = await fx.sh.getJson(`./diy.sh ui layout get ${page}`);
    return (r.data as any)?.data;
  }

  it("get：返回有效布局 + 用户态偏离项", async () => {
    await fx.sh.getJson("./diy.sh ui layout reset task-run");
    const d = await layout();
    expect(d.hidden).toEqual(["bottom", "right"]); // 开发者默认（DEFAULT_HIDDEN）
    expect(d.hiddenViews).toEqual([]);
    expect(d.maximized).toBeNull();
    expect(d.layout.areas.map((a: any) => a.id)).toEqual(["left", "center", "right", "bottom"]);
    // right / bottom 默认收起 → 它们的独占 track 归零
    expect(d.layout.cols[2]).toEqual({ unit: "px", value: 0 });
    expect(d.layout.rows[1]).toEqual({ unit: "px", value: 0 });
  });

  it("set --cols 改尺寸：有效布局反映，且**界面上列宽真的变**", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson("./diy.sh ui layout reset task-run");

    await fx.sh.getJson("./diy.sh ui layout set task-run --cols 420,*,0 --rows *,0 --show bottom");
    const d = await layout();
    expect(d.layout.cols[0]).toEqual({ unit: "px", value: 420 });
    expect(d.hidden).toEqual(["right"]); // bottom 已被 --show 打开

    // 界面侧：左栏容器宽度真的接近 420（不是只改了内存）
    const w = await waitUntil(
      async () => {
        const res = await fx.sh.getJson("./diy.sh ui inspect");
        const tree = (res.data as any)?.data?.tree;
        return findNodeRect(tree, (n) => n.text === "任务详情")?.w ?? 0;
      },
      (v) => v > 380,
      { label: "左栏宽度跟上" },
    );
    expect(w).toBeLessThan(470);
  });

  it("非法 --cols 被拒（不静默退化）", async () => {
    await fx.sh.assertSession(`
      $! ./diy.sh ui layout set task-run --cols abc
      *--cols 格式非法*
    `);
  });

  it("reset：回到开发者默认（尺寸 + 开合 + 最大化）", async () => {
    await fx.sh.getJson("./diy.sh ui layout set task-run --cols 420,*,0 --maximize center");
    expect((await layout()).maximized).toBe("center");

    await fx.sh.getJson("./diy.sh ui layout reset task-run");
    const d = await layout();
    expect(d.maximized).toBeNull();
    expect(d.hidden).toEqual(["bottom", "right"]);
    expect(d.layout.cols[0]).toEqual({ unit: "px", value: 300 });
  });

  it("get 的 hiddenViews：不传 ctx = 看全貌，传 ctx = 只看本实例（不串台）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui view set chat.local closed --ctx ${uri}`);

    // 不传 ctx → 全貌（排障用）
    const all = await layout();
    expect(all.hiddenViews).toContain(`chat.local@${uri}`);

    // 传本实例 ctx → 有这条
    const mine = await fx.sh.getJson(`./diy.sh ui layout get task-run --ctx ${uri}`);
    expect((mine.data as any).data.hiddenViews).toEqual([`chat.local@${uri}`]);

    // 传别的 ctx → 不该看到（view 隐藏按实例，不是按 page）
    const other = await fx.sh.getJson("./diy.sh ui layout get task-run --ctx projects/1/tasks/999");
    expect((other.data as any).data.hiddenViews).toEqual([]);

    await fx.sh.getJson(`./diy.sh ui view set chat.local open --ctx ${uri}`);
  });
});

// ═══════════════════════════════════════════════════════════════
// 第二种测试能力：**真实 UI 操作**（CDP 注入原生鼠标事件）
//
// 与上面的 `ui tab open` / `ui layout set` 分工不同：
//   上面验「核心能力」（状态机 / 契约 / 数据流），快且可断言细节；
//   这里验「界面真的点得动」—— 事件走完整命中测试，与真人点击同路径。
// 拖动只在拖线实现得稳时做，否则退化为「点全屏 / 开合」等核心交互。
// ═══════════════════════════════════════════════════════════════

describe("真实 UI 操作 —— 点击（第二种测试能力）", () => {
  let ui: UiDriver;

  beforeAll(async () => {
    ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
  });

  afterAll(() => ui?.close());

  it("点面包屑「任务管理」→ 真的回到任务树", async () => {
    // 这条曾经是假绿：面包屑的祖先项 onClick 写成空函数（注释「App 侧会处理」，
    // 实际没人处理），点击毫无反应 —— 但断言只查了「tab 列表」于是照样通过。
    // 现在断言改查**界面**：主区不该再有「任务详情」。
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await waitUntil(a11yText, (t) => t.includes("任务详情"), { label: "任务执行页上屏" });

    await ui.click("任务管理");
    const text = await waitUntil(a11yText, (t) => !t.includes("任务详情"), { label: "回到任务树" });
    expect(text).toContain("创建项目"); // 任务管理页在
    expect((await tabs()).active).toBe(""); // 状态与界面一致
  });

  it("点 area 开合按钮 → 界面真的收掉该区域，再点回来", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson("./diy.sh ui layout reset task-run");
    await waitUntil(a11yText, (t) => t.includes("① left") && t.includes("任务详情"), { label: "三栏就位" });

    await ui.click("① left");
    const closed = await waitUntil(a11yText, (t) => !t.includes("任务详情"), { label: "左栏收起" });
    expect(closed).toContain("② center"); // chat 仍在

    await ui.click("① left"); // 不是单向破坏，点得回来
    expect(await waitUntil(a11yText, (t) => t.includes("任务详情"), { label: "左栏展开" })).toContain("任务详情");
  });

  it("点侧栏 tab 的 ✕ → 真的关掉该 tab", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    expect((await tabs()).opened).toContain(`task-run:${uri}`);

    // 侧栏默认是图标 rail（收起态装不下 ✕），先按真人路径锁定展开
    await ui.clickSelector('button[title="锁定展开"]');
    // ✕ 是 `opacity-0 group-hover:opacity-70`：a11y 树把它当不可见剔除（opacity:0），
    // 且 CDP 注入的 mouseMoved 不会触发 CSS :hover（见 ui-drive 注释）。但它照样
    // 命中测试正常 —— 故按 DOM 取坐标、用 CDP 原生事件真实点击。
    await ui.clickSelector("button[title*='关闭']");
    await new Promise((r) => setTimeout(r, 300));

    const after = await waitUntil(tabs, (t) => !t.opened.includes(`task-run:${uri}`), {
      label: "tab 被关掉",
    });
    expect(after.opened).not.toContain(`task-run:${uri}`);
    expect(after.active).toBe("");
    await ui.clickSelector('button[title*="取消锁定"]'); // 还原，别影响后续用例
  });
});

// ═══════════════════════════════════════════════════════════════
// 任务层次的表达：同链相邻 + 子任务缩进
//   场景：先开 a/b/c，再开 a —— 原先两个 task-run tab 平级并列，看不出父子。
// ═══════════════════════════════════════════════════════════════

describe("打开列表表达任务层次（排序 + 缩进）", () => {
  let a = "";
  let c = "";

  it("setup: 造 a 与 a/b/c 三个任务", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/nest --label Nest`);
    const pid = String((p.data as any)?.data?.id);
    const r1 = await fx.sh.getJson(`./diy.sh task create 父任务 ${pid}`);
    a = String((r1.data as any)?.data?.uri);
    const r2 = await fx.sh.getJson(`./diy.sh task create 中任务 ${pid} --parent ${a}`);
    const b = String((r2.data as any)?.data?.uri);
    const r3 = await fx.sh.getJson(`./diy.sh task create 孙任务 ${pid} --parent ${b}`);
    c = String((r3.data as any)?.data?.uri);
    expect(a).toMatch(/tasks\/\d+$/);
    expect(c).not.toBe(a);
  });

  it("先开孙、再开父 → 两者相邻且父在前（不是平级并列）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab close task-run:${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ${c}`); // 先开 a/b/c
    await fx.sh.getJson(`./diy.sh ui tab open ${a}`); // 再开 a

    const list = (await tabs()).opened;
    const ia = list.indexOf(`task-run:${a}`);
    const ic = list.indexOf(`task-run:${c}`);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ic).toBe(ia + 1); // 紧跟父之后 —— 缩进才有意义
  });

  it("界面：孙任务比父任务更靠右（真的缩进了）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${a}`);
    // 侧栏默认收起，展开才能量缩进
    const ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      await ui.clickSelector('button[title="锁定展开"]');
      // 量**内容**的左边界，不是元素本身：缩进走 padding-left，而
      // getBoundingClientRect().x 是 border box（padding 不改它）—— 量错了会假绿。
      const xOf = async (title: string) =>
        ui.query<number | null>(`(() => {
          const el = [...document.querySelectorAll('div[title]')].find(d => d.getAttribute('title') === ${JSON.stringify(title)});
          if (!el) return null;
          const inner = el.querySelector('span');
          return inner ? inner.getBoundingClientRect().x : el.getBoundingClientRect().x;
        })()`);
      const xa = await waitUntil(() => xOf(a), (v) => v !== null, { label: "父 tab 上屏" });
      const xc = await xOf(c);
      expect(xa).not.toBeNull();
      expect(xc).not.toBeNull();
      expect(xc!).toBeGreaterThan(xa!); // 孙更靠右
      await ui.clickSelector('button[title*="取消锁定"]');
    } finally {
      ui.close();
    }
  });

  it("关父 tab 不影响子任务 tab（任务层次不承担生命周期）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${a}`);
    await fx.sh.getJson(`./diy.sh ui tab close task-run:${a}`);
    expect((await tabs()).opened).toContain(`task-run:${c}`);
  });
});

// ═══════════════════════════════════════════════════════════════
// 任务被移动 → 导航结构实时跟随（165 回归）
//
// 场景：a → b → c 三级，三个 tab 都开着，然后把 c 改挂到 a 之下（跳过 b）。
// 修复前：tab 里存着**打开那一刻**的祖先链快照，树变了导航照旧 —— 缩进仍指着旧父，
// 顺序也不收拢，刷新页面同样无效（陈旧数据被原样读回）。
// 现在：祖先链现算，缩进与顺序立刻跟随，不需要任何「reconcile」入口。
// ═══════════════════════════════════════════════════════════════

describe("任务被移动 → 导航结构实时跟随（165 回归）", () => {
  let a = "", b = "", c = "", x = "", y = "";

  it("setup: 造 a → b → c 三级，外加两个独立任务 x / y", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/move --label Move`);
    const pid = String((p.data as any)?.data?.id);
    const uriOf = (r: any) => String((r.data as any)?.data?.uri);
    a = uriOf(await fx.sh.getJson(`./diy.sh task create 移动-祖父 ${pid}`));
    b = uriOf(await fx.sh.getJson(`./diy.sh task create 移动-父 ${pid} --parent ${a}`));
    c = uriOf(await fx.sh.getJson(`./diy.sh task create 移动-孙 ${pid} --parent ${b}`));
    x = uriOf(await fx.sh.getJson(`./diy.sh task create 移动-独立X ${pid}`));
    y = uriOf(await fx.sh.getJson(`./diy.sh task create 移动-独立Y ${pid}`));
    expect(c).not.toBe(b);
  });

  it("缩进跟随：孙改挂到祖父之下 → 缩进从 2 级降为 1 级（与父同层）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${c}`);
    await fx.sh.getJson(`./diy.sh ui tab open ${b}`);
    await fx.sh.getJson(`./diy.sh ui tab open ${a}`);

    const ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      await ui.clickSelector('button[title="锁定展开"]');
      // 量**内容**左边界：缩进走 padding-left，而 border box 的 x 不受 padding 影响
      const xOf = (title: string) =>
        ui.query<number | null>(`(() => {
          const el = [...document.querySelectorAll('div[title]')].find(d => d.getAttribute('title') === ${JSON.stringify(title)});
          if (!el) return null;
          const inner = el.querySelector('span');
          return inner ? inner.getBoundingClientRect().x : el.getBoundingClientRect().x;
        })()`);
      const xb0 = await waitUntil(() => xOf(b), (v) => v !== null, { label: "父 tab 上屏" });
      const xc0 = await xOf(c);
      expect(xc0! > xb0!).toBe(true); // 移动前：孙比父更深一层

      await fx.sh.getJson(`./diy.sh task move ${c} ${a}`); // 孙改挂到祖父之下（跳过父）

      const aligned = await waitUntil(
        async () => {
          const xb = await xOf(b);
          const xc = await xOf(c);
          return xb === null || xc === null ? false : Math.abs(xc - xb) < 1;
        },
        (ok) => ok === true,
        { label: "缩进跟随新树（父与孙同层）" },
      );
      expect(aligned).toBe(true);
      await ui.clickSelector('button[title*="取消锁定"]');
    } finally {
      ui.close();
    }
  });

  it("顺序跟随：把 y 移到 x 之下 → y 从 x 之前收拢到 x 之后", async () => {
    await fx.sh.getJson(`./diy.sh ui tab close task-run:${a}`);
    await fx.sh.getJson(`./diy.sh ui tab close task-run:${b}`);
    await fx.sh.getJson(`./diy.sh ui tab close task-run:${c}`);
    await fx.sh.getJson(`./diy.sh ui tab open ${y}`);
    await fx.sh.getJson(`./diy.sh ui tab open ${x}`);
    const mine = async () => (await tabs()).opened.filter((k) => k === `task-run:${x}` || k === `task-run:${y}`);
    expect(await mine()).toEqual([`task-run:${y}`, `task-run:${x}`]); // 都是顶级：按打开顺序平级

    await fx.sh.getJson(`./diy.sh task move ${y} ${x}`); // y 变成 x 的子任务

    expect(await waitUntil(mine, (l) => l[0] === `task-run:${x}`, { label: "顺序收拢到父之后" }))
      .toEqual([`task-run:${x}`, `task-run:${y}`]);
  });
});
