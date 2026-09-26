// tests/core/task-list.test.ts
// 🎯 任务列表排序 / 搜索 / 剪枝 / 片段提取 —— 纯函数单测（无 DOM，无 Electron）
//
// 为什么要这些用例：表格的"看起来对"是唯一能靠肉眼验的东西，而这些规则本身
// 全是可判定的（同级排序、未设置值恒排最后、命中保祖先链、片段上下文与折叠）。
// 踩过的真实故障就藏在这里：任务号按字典序排会把 #9 排到 #100 之后。

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SORT,
  buildSnippet,
  buildTaskRows,
  formatSort,
  matchTask,
  parseSort,
  SORT_KEYS,
  sortTasks,
  taskComparator,
  taskRowKey,
  toggleSort,
  type TaskListNode,
} from "../../src/shared/task-list";

// ─── 构造节点的小工具（只填关心的字段） ───

function task(num: string, over: Partial<TaskListNode> = {}): TaskListNode {
  return {
    kind: "task",
    uri: `projects/1/tasks/${num}`,
    num,
    title: `任务${num}`,
    state: "pending",
    children: [],
    ...over,
  };
}

function project(children: TaskListNode[], over: Partial<TaskListNode> = {}): TaskListNode {
  return { kind: "project", project: "1", title: "项目一", children, ...over };
}

const always = () => true;
const never = () => false;

describe("排序规格解析", () => {
  it("默认 = 创建时间升序（用户选定的默认，改动即行为变更）", () => {
    expect(DEFAULT_SORT).toEqual({ key: "created", dir: "asc" });
    expect(parseSort(undefined)).toEqual(DEFAULT_SORT);
    expect(parseSort("")).toEqual(DEFAULT_SORT);
  });

  it("形状不对 / 不认识的键 → 回落默认（缓存里有脏值不该让表格崩）", () => {
    expect(parseSort("nonsense")).toEqual(DEFAULT_SORT);
    expect(parseSort("created:sideways")).toEqual(DEFAULT_SORT);
    expect(parseSort("unknownkey:asc")).toEqual(DEFAULT_SORT);
  });

  it("往返：formatSort(parseSort(x)) == x", () => {
    for (const raw of ["created:asc", "updated:desc", "num:asc", "priority:desc", "title:asc"]) {
      expect(formatSort(parseSort(raw))).toBe(raw);
    }
  });

  it("点表头：同键翻方向，异键用该键的默认方向", () => {
    expect(toggleSort({ key: "created", dir: "asc" }, "created")).toEqual({ key: "created", dir: "desc" });
    // 除 updated 外一律升序：枚举按声明序（P0 位次最小 → 升序 = P0 在前）、
    // 时间线/任务号/文本同理。updated 降序是唯一例外（"最近改了什么"）。
    for (const k of ["created", "num", "priority", "state", "change_type", "module", "title"] as const) {
      expect(toggleSort({ key: "updated", dir: "desc" }, k), k).toEqual({ key: k, dir: "asc" });
    }
    expect(toggleSort({ key: "created", dir: "asc" }, "updated")).toEqual({ key: "updated", dir: "desc" });
  });
});

describe("排序", () => {
  it("任务号按数值排（字典序会把 9 排到 100 之后 —— 真实故障）", () => {
    const list = [task("100"), task("9"), task("10")];
    expect(sortTasks(list, { key: "num", dir: "asc" }).map((n) => n.num)).toEqual(["9", "10", "100"]);
    expect(sortTasks(list, { key: "num", dir: "desc" }).map((n) => n.num)).toEqual(["100", "10", "9"]);
  });

  it("时间按 ISO 字符串排 = 时间序（无需解析 Date）", () => {
    const a = task("1", { created: "2026-01-02T00:00:00Z" });
    const b = task("2", { created: "2026-01-01T00:00:00Z" });
    expect(sortTasks([a, b], { key: "created", dir: "asc" }).map((n) => n.num)).toEqual(["2", "1"]);
  });

  it("未设置的值**恒排最后**，升序降序都不让它挤到前面", () => {
    const hasP0 = task("1", { priority: "P0" });
    const none = task("2");
    for (const dir of ["asc", "desc"] as const) {
      const out = sortTasks([none, hasP0], { key: "priority", dir }).map((n) => n.num);
      expect(out).toEqual(["1", "2"]);
    }
  });

  it("**点一次「优先级」得到 P0 在前**（方向语义；旧用例只看 order[0] 抓不住这类反向 bug）", () => {
    const list = [task("3", { priority: "P3" }), task("2", { priority: "P2" }), task("1", { priority: "P0" })];
    const first = toggleSort({ key: "created", dir: "asc" }, "priority");
    expect(first).toEqual({ key: "priority", dir: "asc" });
    expect(sortTasks(list, first).map((n) => n.priority)).toEqual(["P0", "P2", "P3"]);
    // 再点一次翻成降序 = P3 在前（这是"翻方向"，与"首次要不要 P0 在前"是两回事）
    expect(sortTasks(list, toggleSort(first, "priority")).map((n) => n.priority)).toEqual(["P3", "P2", "P0"]);
  });

  it("**点一次「状态」得到待处理在前**（同样按 TASK_STATES 声明序，不是字母序）", () => {
    const list = [task("1", { state: "shelved" }), task("2", { state: "pending" }), task("3", { state: "active" })];
    const first = toggleSort({ key: "created", dir: "asc" }, "state");
    expect(sortTasks(list, first).map((n) => n.state)).toEqual(["pending", "active", "shelved"]);
  });

  it("优先级按 P0<P1<P2<P3 位次排，不靠字典序巧合", () => {
    const list = [task("3", { priority: "P3" }), task("1", { priority: "P0" }), task("2", { priority: "P2" })];
    expect(sortTasks(list, { key: "priority", dir: "asc" }).map((n) => n.priority)).toEqual(["P0", "P2", "P3"]);
  });

  it("状态按 TASK_STATES 的声明序排（而不是字母序）", () => {
    const list = [task("1", { state: "shelved" }), task("2", { state: "pending" }), task("3", { state: "active" })];
    expect(sortTasks(list, { key: "state", dir: "asc" }).map((n) => n.state)).toEqual(["pending", "active", "shelved"]);
  });

  it("词表外的历史手写值排到已知值之后，但不丢（不被过滤掉）", () => {
    const list = [task("2", { priority: "high" }), task("1", { priority: "P3" })];
    const out = sortTasks(list, { key: "priority", dir: "asc" });
    expect(out.map((n) => n.priority)).toEqual(["P3", "high"]);
  });

  it("排序不改入参（返回新数组）", () => {
    const list = [task("2"), task("1")];
    sortTasks(list, { key: "num", dir: "asc" });
    expect(list.map((n) => n.num)).toEqual(["2", "1"]);
  });

  it("比较器对相等键返回 0（稳定排序依赖它）", () => {
    const cmp = taskComparator({ key: "created", dir: "asc" });
    expect(cmp(task("1"), task("2"))).toBe(0);
  });
});

describe("搜索片段", () => {
  it("截出命中前后各一段，两侧加省略号", () => {
    const text = "开头".repeat(40) + "关键词" + "结尾".repeat(40);
    const s = buildSnippet(text, "关键词", 10)!;
    expect(s.match).toBe("关键词");
    expect(s.before.startsWith("…")).toBe(true);
    expect(s.after.endsWith("…")).toBe(true);
    expect(s.before.length).toBe(11); // 省略号 + 10 字
  });

  it("命中处贴近开头/结尾时不加多余的省略号", () => {
    const s = buildSnippet("关键词在后", "关键词", 5)!;
    expect(s.before).toBe("");
    expect(s.after).toBe("在后");
  });

  it("空白折叠：Markdown 的换行/缩进在单行片段里不残留", () => {
    const s = buildSnippet("第一行\n\n  第二行 关键词\n第三行", "关键词")!;
    expect(`${s.before}${s.match}${s.after}`).not.toContain("\n");
    expect(s.match).toBe("关键词");
  });

  it("忽略大小写匹配，但片段里保留原文大小写", () => {
    const s = buildSnippet("see WebSocket here", "websocket")!;
    expect(s.match).toBe("WebSocket");
  });

  it("统计命中处数（供 `+N 处` 角标）", () => {
    expect(buildSnippet("a 词 b 词 c 词", "词")!.count).toBe(3);
    expect(buildSnippet("只有一个", "一个")!.count).toBe(1);
  });

  it("无命中 / 空查询返回 null", () => {
    expect(buildSnippet("abc", "zzz")).toBeNull();
    expect(buildSnippet("abc", "  ")).toBeNull();
    expect(buildSnippet("", "a")).toBeNull();
  });
});

describe("搜索匹配", () => {
  it("匹配标题 / 编号（带不带 # 都算）/ URI / 模块 / 类型 / 优先级 / 状态", () => {
    const n = task("42", {
      title: "修导航",
      uri: "projects/7/tasks/42",
      module: "agent/ui",
      change_type: "fix",
      priority: "P1",
      state: "blocked",
    });
    for (const q of ["修导航", "42", "#42", "projects/7", "agent/ui", "fix", "P1", "blocked"]) {
      expect(matchTask(n, q), q).not.toBeNull();
    }
    expect(matchTask(n, "不存在的词")).toBeNull();
  });

  it("正文命中 → 带片段；标题命中 → 不带片段（标题本来就在眼前）", () => {
    const n = task("1", { title: "标题词", body: "正文里的关键词在这里" });
    expect(matchTask(n, "标题词")).toEqual({ snippet: null });
    expect(matchTask(n, "关键词")?.snippet?.match).toBe("关键词");
  });

  it("URI 算本任务自身的信息（搜项目路径是有意的，不是漏网）", () => {
    const n = task("42", { uri: "projects/7/tasks/42" });
    expect(matchTask(n, "projects/7"), "按项目路径搜出该任务").not.toBeNull();
    expect(matchTask(n, "tasks/42")).not.toBeNull();
  });

  it("空查询不匹配任何任务", () => {
    expect(matchTask(task("1"), "   ")).toBeNull();
  });
});

describe("扁平化与剪枝", () => {
  const tree = [
    project([
      task("1", { title: "甲", children: [task("2", { title: "乙" })] }),
      task("3", { title: "丙", body: "无关内容" }),
    ]),
  ];

  // 真实调用方（TaskTree）的展开语义：**项目默认展开、任务默认折叠**（两者的 key 含义相反），
  // 故这里的假函数按节点类型给值 —— 写死 true/false 会掩盖这条语义。
  const projOpenTaskClosed = (n: TaskListNode) => n.kind === "project";

  it("非搜索态：按展开状态展示，任务折叠时只有项目 + 一级任务", () => {
    const rows = buildTaskRows(tree, { sort: DEFAULT_SORT, query: "", isExpanded: projOpenTaskClosed });
    expect(rows.map((r) => r.node.title)).toEqual(["项目一", "甲", "丙"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
  });

  it("非搜索态：展开父任务后子任务出现", () => {
    const rows = buildTaskRows(tree, {
      sort: DEFAULT_SORT,
      query: "",
      isExpanded: (n) => n.kind === "project" || n.title === "甲",
    });
    expect(rows.map((r) => r.node.title)).toEqual(["项目一", "甲", "乙", "丙"]);
  });

  it("搜索态：剪枝为命中链（命中行 + 其祖先），无关分支整条消失", () => {
    const rows = buildTaskRows(tree, { sort: DEFAULT_SORT, query: "乙", isExpanded: never });
    expect(rows.map((r) => r.node.title)).toEqual(["项目一", "甲", "乙"]);
  });

  it("搜索态：命中项**强制展开**（被折叠状态挡住等于搜不到）", () => {
    // isExpanded 恒 false（用户把一切都折叠了），子任务命中仍然要显示
    const rows = buildTaskRows(tree, { sort: DEFAULT_SORT, query: "乙", isExpanded: never });
    expect(rows.some((r) => r.node.title === "乙")).toBe(true);
  });

  it("搜索态：祖先行是「被保链」的过路节点（不参与命中判定，也不带片段）", () => {
    const rows = buildTaskRows(tree, { sort: DEFAULT_SORT, query: "乙", isExpanded: never });
    expect(rows.find((r) => r.node.title === "甲")!.match).toBeNull();
  });

  it("搜索态：整个项目都不命中 → 项目分组也不出现", () => {
    const rows = buildTaskRows(tree, { sort: DEFAULT_SORT, query: "查无此词", isExpanded: always });
    expect(rows).toEqual([]);
  });

  it("搜索态：项目名命中 → 该项目**整棵展开**（搜项目 = 想看它下面的东西，含深层子任务）", () => {
    const rows = buildTaskRows(tree, { sort: DEFAULT_SORT, query: "项目一", isExpanded: never });
    expect(rows.map((r) => r.node.title)).toEqual(["项目一", "甲", "乙", "丙"]);
  });

  it("搜索态：命中行带 match（含正文片段），祖先行不带", () => {
    const rows = buildTaskRows(tree, { sort: DEFAULT_SORT, query: "无关内容", isExpanded: never });
    const hit = rows.find((r) => r.node.title === "丙")!;
    expect(hit.match?.snippet?.match).toBe("无关内容");
    expect(rows.find((r) => r.node.title === "项目一")!.match).toBeNull();
  });

  it("排序作用于同级兄弟：父任务与子任务各自独立排序", () => {
    const t = [
      project([
        task("5", { title: "二", created: "2026-02-01T00:00:00Z" }),
        task("1", { title: "一", created: "2026-01-01T00:00:00Z", children: [task("9", { created: "2026-03-01T00:00:00Z" }), task("2", { created: "2026-01-05T00:00:00Z" })] }),
      ]),
    ];
    const rows = buildTaskRows(t, { sort: { key: "created", dir: "asc" }, query: "", isExpanded: always });
    // 只取任务行（项目行没有 num），并按树序：父任务 1 之后接它的子任务，然后才是下一个兄弟 5
    expect(rows.filter((r) => r.node.kind === "task").map((r) => r.node.num)).toEqual(["1", "2", "9", "5"]);
  });

  it("项目分组顺序不参与排序（项目是分组容器，不是可排序的兄弟）", () => {
    const t = [
      project([task("1")], { project: "1", title: "早建的" }),
      project([task("1")], { project: "2", title: "晚建的" }),
    ];
    const rows = buildTaskRows(t, { sort: { key: "title", dir: "desc" }, query: "", isExpanded: always });
    expect(rows.filter((r) => r.node.kind === "project").map((r) => r.node.title)).toEqual(["早建的", "晚建的"]);
  });
});

describe("排序键清单（列顺序与可用键的唯一真相源）", () => {
  it("清单含全部数据列，且「标题」在内（列能点就得在清单里）", () => {
    const keys = SORT_KEYS.map((s) => s.key);
    expect(keys).toEqual([
      "title",
      "change_type",
      "module",
      "priority",
      "state",
      "num",
      "created",
      "updated",
    ]);
  });

  it("清单 = 可用键（不再有「清单里没有但 parse 认识」的键）", () => {
    for (const { key } of SORT_KEYS) {
      expect(parseSort(`${key}:desc`), key).toEqual({ key, dir: "desc" });
    }
  });
});

describe("行 key", () => {
  it("任务用 uri，项目用 proj:<id>（拖拽/缓存都以它为准）", () => {
    expect(taskRowKey(task("7"))).toBe("projects/1/tasks/7");
    expect(taskRowKey(project([]))).toBe("proj:1");
  });
});
