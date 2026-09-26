// tests/cli.intent.ui.task-list.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 任务表格的**排序 / 搜索 / 列** —— 走真实 renderer（真实 Electron + 真实鼠标键盘）
//
// 为什么必须用真实 UI（而不是只测 shared/task-list 的纯函数）：
//   纯函数层已经覆盖了"排序规则对"，但这里要验的是**接上了没有**：
//   点表头真的改变 DOM 行序、输入搜索词真的剪出命中并弹出动态条、
//   片段真的渲染在行内。这些断链在纯函数测试里全是绿的。
//
// 断言用真实 DOM（`eval` 只读 DOM，不改状态）+ `ui inspect` 的 a11y 树（用户可见的东西）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
/** 测试用项目 id（本文件内所有任务都在它下面，隔离于其他用例） */
let PID = "";

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(fx.electron.cdpUrl, () => a11y());

  // 走 renderer 入口建项目 + 任务（同人类点按钮一套逻辑）
  const p = await fx.sh.getJson(`./diy.sh ui project create ${HOME}/list-repo --label 列表项目`);
  PID = String((p.data as any)?.data?.id);

  // 三个任务，建序 = 1,2,3；正文里埋一个只有第二个任务才有的词，用于验证"正文命中"的片段
  for (const title of ["甲任务导航", "乙任务搜索", "丙任务排序"]) {
    await fx.sh.getJson(`./diy.sh ui task create ${title} ${PID}`);
  }
  await fx.sh.getJson(
    `./diy.sh ui task update projects/${PID}/tasks/2 --body "这里是乙任务的正文，含一个独特词：棱镜天线，后面还要有足够长度通过最小正文校验。"`,
  );
  await fx.sh.getJson(`./diy.sh ui task update projects/${PID}/tasks/1 --change_type feat --module agent/ui --priority P1`);

  // 打开任务页（任务树所在页）
  await fx.sh.run(`./diy.sh ui page navigate task`);
});

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

/** a11y 树（renderer 可见元素的真实快照） */
async function a11y(): Promise<A11yNode | undefined> {
  const r = await fx.sh.getJson("./diy.sh ui inspect");
  return (r.data as any)?.data?.tree as A11yNode | undefined;
}

/** 摊平 a11y 树的全部可见文本。`ui inspect` 的 tree 是**单个根节点**（不是数组），
 *  故这里统一按「可能是数组、也可能是单节点」处理（既有测试的 collectText 只用数组形态）。 */
function collectText(nodes: any, acc: string[] = []): string[] {
  const list = Array.isArray(nodes) ? nodes : nodes ? [nodes] : [];
  for (const n of list) {
    if (n?.text) acc.push(String(n.text));
    collectText(n?.children, acc);
  }
  return acc;
}

/** 表格里任务行的 uri 顺序（= 用户看到的上→下顺序），从真实 DOM 读 */
function rowOrder(): Promise<string[]> {
  return ui.eval<string[]>(
    `Array.from(document.querySelectorAll('tbody tr[data-uri]')).map(tr => tr.getAttribute('data-uri'))`,
  );
}

/** 表格表头文本（按列顺序） */
function headerTexts(): Promise<string[]> {
  // 去空白：表头按钮里是「标签 + ⇅ 箭头」（含换行），空白会让 startsWith 断言受排版影响
  return ui.eval<string[]>(
    `Array.from(document.querySelectorAll('thead th')).map(th => th.innerText.replace(/\\s+/g, ""))`,
  );
}

/** 详情面板里三个结构化控件的当前值（回显断言用；面板 = 右锚定的 .card.absolute） */
function panelFieldValues(): Promise<{ selects: string[]; modules: string[] }> {
  return ui.eval(`(() => {
    const panel = document.querySelector('.card.absolute');
    if (!panel) return { selects: [], modules: [] };
    return {
      selects: Array.from(panel.querySelectorAll('select')).map(s => s.value),
      modules: Array.from(panel.querySelectorAll('input[list="diy-task-modules"]')).map(i => i.value),
    };
  })()`);
}

/** 点表头（按列名，走真实命中测试的鼠标点击） */
async function clickHeader(label: string): Promise<void> {
  await ui.click((text) => text.replace(/\s+/g, "").startsWith(label));
}

/**
 * 清空搜索框并输词 —— **真实键盘输入**（不是 `el.value = x`）。
 *
 * 清空走 Esc：这是产品里写明的行为（搜索框 onKeyDown Escape → 清空），
 * 比「Meta+A 全选再覆盖」少依赖一层快捷键匹配，且用户就是这么按的。
 * 输完**核对输入框的 value**：输入没进去时立刻明确报错，而不是等下游断言莫名失败。
 */
async function search(word: string): Promise<void> {
  await ui.clickSelector('input[type="search"]');
  await ui.press("Escape");
  if (word) await ui.type(word);
  const value = await waitUntil(
    () => ui.eval<string>(`document.querySelector('input[type="search"]')?.value ?? ""`),
    (v) => v === word,
    { label: `搜索框内容应为「${word}」` },
  );
  expect(value, "搜索框内容（键盘输入真的进去了）").toBe(word);
}

describe("任务表格：列", () => {
  it("列出结构化字段与时间列（含排序入口）", async () => {
    const headers = await headerTexts();
    for (const col of ["标题", "类型", "模块", "优先级", "编号", "创建", "修改"]) {
      expect(headers.some((h) => h.startsWith(col)), `${col} 列存在，实际表头: ${headers.join(" | ")}`).toBe(true);
    }
  });

  it("字段值渲染到对应列里（未设置的显示占位符，不是空白）", async () => {
    // 读 DOM 单元格而不是 a11y 文本：a11y 把整表摊平成一行字符串（"# 1" 之间会插空格），
    // 按列断言必须拿到单元格边界
    const cells = (uri: string): Promise<string[]> =>
      ui.eval<string[]>(
        `(() => {
           const tr = document.querySelector('tbody tr[data-uri="${uri}"]');
           if (!tr) return [];
           return Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
         })()`,
      );

    // 任务 1：三个字段都有值，列序 = 标题 / 类型 / 模块 / 优先级 / 状态 / 编号 / 创建 / 修改
    const t1 = await cells(`projects/${PID}/tasks/1`);
    expect(t1[1]).toBe("feat");
    expect(t1[2]).toBe("agent/ui");
    expect(t1[3]).toBe("P1");
    expect(t1[5]).toBe("1"); // 编号列
    expect(t1[6]).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/); // 创建时间已格式化，不是空

    // 任务 2：字段未设置 → 占位符（空白会让人分不清"没填"和"渲染坏了"）
    const t2 = await cells(`projects/${PID}/tasks/2`);
    expect(t2[1]).toBe("—");
    expect(t2[2]).toBe("—");
    expect(t2[3]).toBe("—");
  });
});

describe("任务表格：排序", () => {
  it("默认按创建时间升序（= 建序，不是文件名的字典序）", async () => {
    // 先确保回到默认：加载时就是默认，这里只断言现状
    const order = await rowOrder();
    expect(order).toEqual([
      `projects/${PID}/tasks/1`,
      `projects/${PID}/tasks/2`,
      `projects/${PID}/tasks/3`,
    ]);
  });

  it("点「编号」表头 → 降序；再点 → 回到升序（真实点击，顺序真的变）", async () => {
    await clickHeader("编号");
    await waitUntil(rowOrder, (o) => o[0]?.endsWith("/tasks/1"), { label: "编号升序（首次点=升）" });

    await clickHeader("编号"); // 同键再点 → 翻成降序
    const desc = await waitUntil(rowOrder, (o) => o[0]?.endsWith("/tasks/3"), { label: "编号降序" });
    expect(desc).toEqual([
      `projects/${PID}/tasks/3`,
      `projects/${PID}/tasks/2`,
      `projects/${PID}/tasks/1`,
    ]);

    // 复位到创建升序，避免影响后续用例
    await clickHeader("创建");
    await waitUntil(rowOrder, (o) => o[0]?.endsWith("/tasks/1"), { label: "回到创建升序" });
  });

  it("排序规格落到视图 cache（刷新后仍是用户选的）", async () => {
    // 切到「优先级」列（降序：P1 在前，未定级的排最后）
    await clickHeader("优先级");
    const cached = await ui.eval<string>(`localStorage.getItem("diy_task_tree_sort")`);
    expect(cached).toBe("priority:desc");

    // 未定级的任务（2、3）不能挤到有优先级的前面 —— 「未设置恒排最后」
    const order = await waitUntil(rowOrder, (o) => o[0]?.endsWith("/tasks/1"), { label: "P1 排最前" });
    expect(order[0]).toBe(`projects/${PID}/tasks/1`);
  });
});

describe("任务表格：搜索", () => {
  it("按标题命中：只剩命中行 + 它的祖先（项目分组），并弹出动态条", async () => {
    await search("搜索");
    const texts = collectText(await a11y()).join(" ");
    expect(texts).toContain("乙任务搜索");
    expect(texts).not.toContain("甲任务导航");
    // 动态条：计数 + 当前命中项
    expect(texts).toMatch(/1\/1/);

    await search("");
  });

  it("按正文命中：行内出现片段并高亮命中词（搜索覆盖正文）", async () => {
    await search("棱镜天线");
    const texts = collectText(await a11y()).join(" ");
    expect(texts).toContain("棱镜天线");
    // 命中行的 uri 仍在表里（剪枝保留了它），且片段里带上下文（不是只有关键词三个字）
    const order = await rowOrder();
    expect(order).toEqual([`projects/${PID}/tasks/2`]);
    const snippet = await ui.eval<string>(
      `document.querySelector('tbody tr[data-uri] mark')?.textContent ?? ""`,
    );
    expect(snippet).toBe("棱镜天线");

    await search("");
  });

  it("搜不到：动态条显示 0 命中，表格给「没有匹配」而不是空白", async () => {
    await search("绝不存在的词xyz");
    const texts = collectText(await a11y()).join(" ");
    expect(texts).toMatch(/0\/0/);
    expect(texts).toContain("没有匹配");

    await search("");
  });

  it("动态条的 ↓ 在命中之间跳（选中项跟着变）", async () => {
    // "任务" 三个任务都命中（标题里都有）
    await search("任务");
    await waitUntil(rowOrder, (o) => o.length === 3, { label: "三条命中" });
    const texts = collectText(await a11y()).join(" ");
    expect(texts).toMatch(/1\/3/);

    await ui.click("↓");
    const after = collectText(await a11y()).join(" ");
    expect(after).toMatch(/2\/3/);

    await search("");
  });

  it("按字段命中：模块名也能搜到（列里的值参与搜索）", async () => {
    await search("agent/ui");
    const order = await rowOrder();
    expect(order).toEqual([`projects/${PID}/tasks/1`]);
    await search("");
  });
});

describe("getTask 载荷必须带全结构化字段（曾经的实测 bug）", () => {
  it("`diy getTask <uri>` 回传 change_type / module / priority", async () => {
    // 这条是 **175 的 review 抓出来的真 bug 的回归测试**（写得到、读不回）：
    // `diy.getTask` 的字段在**两处各自手抄** —— api-impl 的 handler 一份、api-def 的
    // output schema 一份。我加字段时两处都没登记 → zod `.object()` 把它们 strip 掉 →
    // renderer 拿到 undefined → 详情面板的编辑框恒显示 "—"。
    //
    // 为什么它当初能溜过全绿：我的 UI 用例只验了「在面板里改值 → 落盘 + 表格列变」，
    // **没验「面板回显已有值」**。所以补两条：一条锁 RPC 载荷（本用例），
    // 一条锁界面回显（下一条）。
    const r = await fx.sh.getJson(`./diy.sh getTask projects/${PID}/tasks/1`);
    const d = (r.data as any)?.data;
    expect(d.change_type, "change_type 必须在载荷里（被 strip 就是这里红）").toBe("feat");
    expect(d.module).toBe("agent/ui");
    expect(d.priority).toBe("P1");
  });

  it("字段未被设置时载荷给 undefined（不是被 strip 掉的空壳）", async () => {
    const r = await fx.sh.getJson(`./diy.sh getTask projects/${PID}/tasks/3`);
    const d = (r.data as any)?.data;
    expect(d.title).toBeTruthy(); // 任务本身读到了，说明不是"空对象"这种假绿
    expect(d.change_type).toBeUndefined();
    expect(d.priority).toBeUndefined();
  });
});

describe("任务表格：字段编辑入口（表格列的来源）", () => {
  it("**打开详情面板必须回显任务已有的三个字段**（175 抓出的真 bug 的界面级回归）", async () => {
    // 这是本任务最初漏掉的那个断言：我只验了「改值 → 落盘 + 表格列变」，
    // 没验「面板把已有值显示出来」。于是契约 strip 掉字段时测试照样全绿，
    // 而用户看到的是「填了看不见、改完像没生效」（数据其实好好的）。
    await ui.click("甲任务导航"); // 任务 1：change_type=feat / module=agent/ui / priority=P1
    const v = await waitUntil(
      () => panelFieldValues(),
      (x) => x.modules.includes("agent/ui"),
      { label: "面板回显 agent/ui" },
    );
    expect(v.modules, "module 输入框回显 agent/ui").toContain("agent/ui");
    expect(v.selects, "change_type 下拉回显 feat").toContain("feat");
    expect(v.selects, "优先级下拉回显 P1").toContain("P1");
  });

  it("详情面板改优先级 → 表格列与数据都跟着变", async () => {
    // 点开任务 2 的详情（点标题）
    await ui.click("乙任务搜索");
    // 面板里的优先级下拉：设为 P0
    await ui.eval(`(() => {
      const sel = document.querySelector('select.font-mono:not([disabled])');
      if (!sel) throw new Error("找不到字段下拉");
      return true;
    })()`);
    // 用真实交互改值：聚焦 select → 键盘选择（原生 select 用按键换值最贴近真人）
    const selRect = await ui.query<{ x: number; y: number }>(`(() => {
      const sels = Array.from(document.querySelectorAll('select'));
      const sel = sels.find(s => Array.from(s.options).some(o => o.value === "P0"));
      if (!sel) return { x: -1, y: -1 };
      const r = sel.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    expect(selRect.x).toBeGreaterThan(0);
    // 直接按值设 + 派发 change：原生 select 的弹层由 OS 绘制，CDP 点不进选项；
    // 但 change 事件走的是页面自己的 handler（与真人选完一项派发的同一种事件）。
    await ui.eval(`(() => {
      const sels = Array.from(document.querySelectorAll('select'));
      const sel = sels.find(s => Array.from(s.options).some(o => o.value === "P0"));
      sel.value = "P0";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);

    // 改完即存 → 面板要立刻反映新值（本用例操作的是**任务 2**，它原本没有字段）
    const after = await waitUntil(
      () => panelFieldValues(),
      (v) => v.selects.includes("P0"),
      { label: "面板回显刚设置的 P0" },
    );
    expect(after.selects, "优先级下拉要显示刚设置的 P0").toContain("P0");

    // 复核：main 侧数据真的变了（而不是只改了 DOM）
    const shown = await waitUntil(
      async () => (await fx.sh.getJson(`./diy.sh task show projects/${PID}/tasks/2`)) as any,
      (r) => r?.data?.data?.priority === "P0",
      { label: "priority 落盘为 P0" },
    );
    expect((shown.data as any).data.priority).toBe("P0");
  });
});
