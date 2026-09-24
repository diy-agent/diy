// tests/core/view-registry.test.ts — view 依赖倒置 + binding 解析
import { describe, expect, it } from "vitest";
import { validateLayout } from "../../src/shared/grid-layout";
import {
  DEFAULT_HIDDEN,
  PAGES,
  TASK_RUN_LAYOUT,
  VIEWS,
  applyHiddenViews,
  areasWithViews,
  checkViewTarget,
  defaultBinding,
  groupViewsByArea,
  findPage,
  placementOrder,
  validateRegistry,
  viewInstanceKey,
  type PageDef,
  type ViewDef,
} from "../../src/shared/view-registry";

describe("注册表自洽", () => {
  it("内置注册表无错（id 唯一 / placement 指向存在的 page 与 area）", () => {
    expect(validateRegistry()).toEqual([]);
  });

  it("每个 page 的 layout 本身合法", () => {
    for (const p of PAGES) {
      expect({ page: p.id, errs: validateLayout(p.layout) }).toEqual({ page: p.id, errs: [] });
    }
  });

  it("placement 指向不存在的 area → 报错（依赖倒置的代价，靠本函数兜住）", () => {
    const views: ViewDef[] = [
      { id: "v.x", title: "X", instanceScope: "global", placement: { task: { area: "nope" } } },
    ];
    const errs = validateRegistry(views, PAGES);
    expect(errs.some((e) => e.msg.includes("nope"))).toBe(true);
  });

  it("placement 指向不存在的 page → 报错", () => {
    const views: ViewDef[] = [
      { id: "v.x", title: "X", instanceScope: "global", placement: { ghost: { area: "main" } } },
    ];
    expect(validateRegistry(views, PAGES).some((e) => e.msg.includes("ghost"))).toBe(true);
  });
});

describe("View vs ViewInstance —— 状态归属", () => {
  it("global 实例键 = view id（单实例）", () => {
    const tree = VIEWS.find((v) => v.id === "task.tree")!;
    expect(viewInstanceKey(tree, null)).toBe("task.tree");
    expect(viewInstanceKey(tree, "projects/4/tasks/133")).toBe("task.tree"); // 上下文被忽略
  });

  it("context 实例键带上下文（多任务 tab 同屏时各持一份状态）", () => {
    const chat = VIEWS.find((v) => v.id === "chat.local")!;
    expect(viewInstanceKey(chat, "projects/4/tasks/133")).toBe("chat.local@projects/4/tasks/133");
    expect(viewInstanceKey(chat, "projects/4/tasks/137")).toBe("chat.local@projects/4/tasks/137");
  });
});

describe("依赖倒置 —— 加 view 不必改 page", () => {
  it("新 view 只要声明 placement 就出现在该 page 的 binding 里", () => {
    const taskRun = findPage("task-run")!;
    const before = defaultBinding(taskRun, "projects/4/tasks/1");

    const extra: ViewDef = {
      id: "agent.params",
      title: "参数状态",
      instanceScope: "context",
      placement: { "task-run": { area: "right", order: 10 } },
    };
    const after = defaultBinding(taskRun, "projects/4/tasks/1", [...VIEWS, extra]);

    expect(before["agent.params@projects/4/tasks/1"]).toBeUndefined();
    expect(after["agent.params@projects/4/tasks/1"]).toBe("right");
    // page 定义本身一个字都没改（同一个对象引用）
    expect(findPage("task-run")!.layout).toBe(TASK_RUN_LAYOUT);
  });

  it("page 白名单：view 未声明该 page → 不进 binding（数据隔离，不用 when 表达式）", () => {
    const llm = findPage("llm")!;
    const b = defaultBinding(llm, null);
    expect(Object.keys(b)).toEqual(["llm.proxy"]); // chat.local 虽有 id 但没声明 llm
    expect(b["chat.local"]).toBeUndefined();
  });
});

describe("defaultBinding", () => {
  it("任务执行页：只挂它自己的 view（lab 已提升为子页面，不再是它的 view）", () => {
    const page = findPage("task-run")!;
    const b = defaultBinding(page, "projects/4/tasks/133");
    expect(b).toEqual({
      "task.detail@projects/4/tasks/133": "left",
      "chat.local@projects/4/tasks/133": "center",
    });
  });

  it("同 view 类型的两个 page 实例 → 两份独立 binding（互不干扰）", () => {
    const page = findPage("task-run")!;
    const a = defaultBinding(page, "projects/4/tasks/133");
    const c = defaultBinding(page, "projects/4/tasks/137");
    expect(Object.keys(a)).not.toEqual(Object.keys(c));
    expect(a["chat.local@projects/4/tasks/133"]).toBe("center");
    expect(c["chat.local@projects/4/tasks/137"]).toBe("center");
  });

  it("settings 的三个 view 同 area，order 决定顺序", () => {
    const page: PageDef = findPage("settings")!;
    const b = defaultBinding(page, null);
    expect(b["settings.appinfo"]).toBe("main");
    const ordered = Object.keys(b).sort(
      (x, y) =>
        placementOrder(VIEWS.find((v) => v.id === x)!, page.id) -
        placementOrder(VIEWS.find((v) => v.id === y)!, page.id),
    );
    expect(ordered).toEqual(["settings.appinfo", "settings.logs", "settings.theme"]);
  });
});

describe("提示词页 = 子页面（不是任务页的底部面板）", () => {
  it("lab 声明了 parentPage（生命周期挂父 tab），且是 multi", () => {
    const lab = findPage("lab")!;
    expect(lab.parentPage).toBe("task-run");
    expect(lab.multi).toBe(true);
  });

  it("任务执行页不再挂 lab 的任何 view", () => {
    const taskRunViews = VIEWS.filter((v) => v.placement["task-run"]).map((v) => v.id).sort();
    expect(taskRunViews).toEqual(["chat.local", "task.detail"]);
  });
});

describe("groupViewsByArea —— layout + binding → 实际要画什么", () => {
  it("任务执行页：按 area 的几何顺序输出（left → center）", () => {
    const page = findPage("task-run")!;
    const ctx = "projects/4/tasks/133";
    const groups = groupViewsByArea(page, ctx, defaultBinding(page, ctx));
    expect(groups.map((g) => g.areaId)).toEqual(["left", "center"]);
    expect(groups[0].views.map((v) => v.id)).toEqual(["task.detail"]);
    expect(groups[1].views.map((v) => v.id)).toEqual(["chat.local"]);
  });

  it("binding[key] = null → 隐藏（实例保留，不销毁重建）", () => {
    const page = findPage("task-run")!;
    const ctx = "projects/4/tasks/1";
    const b = defaultBinding(page, ctx);
    b[`task.detail@${ctx}`] = null; // 用户最小化了左栏
    const groups = groupViewsByArea(page, ctx, b);
    expect(groups.map((g) => g.areaId)).toEqual(["center"]);
  });

  it("binding 改 area → 跟随（把任务详情拖到右侧）", () => {
    const page = findPage("task-run")!;
    const ctx = "projects/4/tasks/1";
    const b = defaultBinding(page, ctx);
    b[`task.detail@${ctx}`] = "right";
    const groups = groupViewsByArea(page, ctx, b);
    expect(groups.find((g) => g.areaId === "right")?.views.map((v) => v.id)).toEqual(["task.detail"]);
    expect(groups.some((g) => g.areaId === "left")).toBe(false);
  });

  it("同 area 多个 view 按 order 排序（设置页：状态 → 日志 → 外观）", () => {
    const page = findPage("settings")!;
    const groups = groupViewsByArea(page, null, defaultBinding(page, null));
    expect(groups).toHaveLength(1);
    expect(groups[0].views.map((v) => v.id)).toEqual([
      "settings.appinfo",
      "settings.logs",
      "settings.theme",
    ]);
  });

  it("指向不存在 area 的 binding 被忽略（不渲染出诡异画面）", () => {
    const page = findPage("task-run")!;
    const ctx = "projects/4/tasks/1";
    const b = defaultBinding(page, ctx);
    b[`chat.local@${ctx}`] = "ghost";
    const groups = groupViewsByArea(page, ctx, b);
    expect(groups.some((g) => g.areaId === "ghost")).toBe(false);
    expect(groups.some((g) => g.areaId === "center")).toBe(false); // 该 view 本可落 center，被非法值挡掉
  });
});

describe("子页面（一页一中心）", () => {
  it("lab 是 task-run 的子页面：声明 parentPage，不进顶级导航", () => {
    const lab = findPage("lab")!;
    expect(lab.parentPage).toBe("task-run");
    expect(lab.multi).toBe(true);
  });

  it("lab 的 view 只在 lab 上（中心 = 编辑器，其余是卫星）", () => {
    const byPage = (pid: string) =>
      VIEWS.filter((v) => v.placement[pid]).map((v) => `${v.id}@${v.placement[pid]!.area}`);
    expect(byPage("lab").sort()).toEqual([
      "chat.local@bottom",     // 边聊边调：与任务页是同一个 view，只是换个 area
      "lab.editor@center",     // 中心
      "lab.inspector@left",
      "lab.request@right",
      "lab.system@right",      // 与 request 同 area → 区域内 tab 互斥
    ]);
  });

  it("chat.local 同时挂在两个 page：靠 placement，不靠嵌套", () => {
    const chat = VIEWS.find((v) => v.id === "chat.local")!;
    expect(chat.placement["task-run"]!.area).toBe("center");
    expect(chat.placement.lab!.area).toBe("bottom");
  });

  it("lab 的默认隐藏：bottom（chat 是卫星，默认不占地方）", () => {
    expect(DEFAULT_HIDDEN.lab).toEqual(["bottom"]);
  });
});

// ═══════════════════════════════════════════
// view 级隐藏（ui view set）—— 与 area 开合、折叠框展开是三件事
// ═══════════════════════════════════════════

describe("applyHiddenViews —— 隐藏走 binding 的 null 语义", () => {
  const page = findPage("task-run")!;
  const ctx = "projects/4/tasks/133";

  it("被隐藏的键置 null，其余不动（同一个 view 的其他实例不受影响）", () => {
    const b = defaultBinding(page, ctx);
    const out = applyHiddenViews(b, { [`chat.local@${ctx}`]: true });
    expect(out[`chat.local@${ctx}`]).toBeNull();
    expect(out[`task.detail@${ctx}`]).toBe("left");
    // 原对象不被改写（纯函数）
    expect(b[`chat.local@${ctx}`]).toBe("center");
  });

  it("空 hiddenViews → 原样返回（不制造新对象）", () => {
    const b = defaultBinding(page, ctx);
    expect(applyHiddenViews(b, {})).toBe(b);
    expect(applyHiddenViews(b, { [`chat.local@${ctx}`]: false })).toBe(b);
  });

  it("陌生键不凭空造条目（脏数据不该让界面多出一个 view）", () => {
    const b = defaultBinding(page, ctx);
    const out = applyHiddenViews(b, { "ghost.view@x": true });
    expect("ghost.view@x" in out).toBe(false);
    expect(Object.keys(out)).toEqual(Object.keys(b));
  });

  it("隐藏后 groupViewsByArea 真的少一块（端到端语义）", () => {
    const b = applyHiddenViews(defaultBinding(page, ctx), { [`task.detail@${ctx}`]: true });
    expect(groupViewsByArea(page, ctx, b).map((g) => g.areaId)).toEqual(["center"]);
  });
});

describe("areasWithViews —— 空 area 的按钮不该出现", () => {
  it("任务执行页：只有 left / center 有 view（right / bottom 还空着）", () => {
    const page = findPage("task-run")!;
    const ctx = "projects/4/tasks/1";
    expect([...areasWithViews(page, ctx, defaultBinding(page, ctx))].sort()).toEqual(["center", "left"]);
  });

  it("提示词页：四个 area 都有 view", () => {
    const page = findPage("lab")!;
    const ctx = "projects/4/tasks/1";
    const got = [...areasWithViews(page, ctx, defaultBinding(page, ctx))].sort();
    expect(got).toEqual(["bottom", "center", "left", "right"]);
  });

  it("view 被隐藏 → 该 area 随之空掉（按钮也应消失）", () => {
    const page = findPage("task-run")!;
    const ctx = "projects/4/tasks/1";
    const b = applyHiddenViews(defaultBinding(page, ctx), {
      [`chat.local@${ctx}`]: true,
      [`task.detail@${ctx}`]: true,
    });
    expect([...areasWithViews(page, ctx, b)]).toEqual([]);
  });

  it("单实例 page 无 ctx 也正常（settings 三个 view 同 area）", () => {
    const page = findPage("settings")!;
    expect([...areasWithViews(page, null, defaultBinding(page, null))]).toEqual(["main"]);
  });
});

describe("checkViewTarget —— 依赖倒置的运行时兜底", () => {
  const ctx = "projects/4/tasks/1";

  it("合法寻址返回 null", () => {
    expect(checkViewTarget("chat.local", "task-run", ctx)).toBeNull();
    expect(checkViewTarget("task.tree", "task", null)).toBeNull();
  });

  it("未知 view / 未知 page", () => {
    expect(checkViewTarget("ghost", "task-run", ctx)).toContain("未知 view");
    expect(checkViewTarget("task.tree", "ghost", null)).toContain("未知 page");
  });

  it("view 未声明该 page → 拒绝（白名单由 placement 承担）", () => {
    expect(checkViewTarget("chat.local", "settings", ctx)).toContain("不允许放在");
  });

  it("context 型必须给 ctx，global 型不该给", () => {
    expect(checkViewTarget("chat.local", "task-run", null)).toContain("必须给上下文键");
    expect(checkViewTarget("task.tree", "task", ctx)).toContain("不该给");
  });
});
