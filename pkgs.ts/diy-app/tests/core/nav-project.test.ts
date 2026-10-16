// tests/core/nav-project.test.ts
// 🎯 nav 按项目分组（##302）的**规则**（纯函数，无 DOM / 无 Electron）
//
// 守的是三件事：
//   ① 分组是**稳定**的：组序 = 项目首次出现顺序，组内保持原相对顺序
//      （nav 顺序是用户心智中的位置，分组只该把同项目的挪到一起，不该顺手重排）
//   ② 归属派生只认真源：项目 id ← projectFromUri(ctx)，显示名 ← 任务树 project 节点
//   ③ 项目色由 id 派生：确定、同 id 同色、不同 id 大概率不同色
import { describe, expect, it } from "vitest";
import {
  groupByProject,
  projectColor,
  projectHue,
  projectIndexOf,
  projectOfCtx,
} from "../../src/shared/nav-project";
import type { TaskNodeShape } from "../../src/main/services/api-def";

const tab = (ctx: string | null) => ({ key: `task-run:${ctx ?? ""}`, pageId: "task-run", ctx });
const uri = (pid: string, n: string) => `projects/${pid}/tasks/${n}`;

/** 任务树的项目节点（只有这几个字段与分组有关） */
const projNode = (id: string, label: string, path?: string): TaskNodeShape =>
  ({ kind: "project", project: id, title: label, project_label: label, project_path: path, children: [] }) as TaskNodeShape;

describe("nav 按项目分组", () => {
  it("projectOfCtx：项目 id 从 URI 派生；空 / 非任务 URI → 空串", () => {
    expect(projectOfCtx(uri("4", "302"))).toBe("4");
    expect(projectOfCtx(uri("abc", "1"))).toBe("abc"); // 非数字项目 id 也算（真源正则允许）
    expect(projectOfCtx(null)).toBe("");
    expect(projectOfCtx("")).toBe("");
    expect(projectOfCtx("not-a-uri")).toBe("");
  });

  it("projectIndexOf：抽项目节点；label 缺省退化 title / id", () => {
    const idx = projectIndexOf([
      projNode("4", "~/git/diy/diy", "~/git/diy/diy"),
      projNode("1", "~/git/cops"),
      { kind: "task", uri: uri("4", "1"), children: [] } as TaskNodeShape, // 任务节点不是项目，跳过
    ]);
    expect([...idx.keys()]).toEqual(["4", "1"]);
    expect(idx.get("4")).toEqual({ id: "4", label: "~/git/diy/diy", path: "~/git/diy/diy" });
    expect(idx.get("1")?.path).toBeUndefined();
  });

  it("组序 = 项目首次出现顺序，组内保持原相对顺序（稳定分组）", () => {
    const idx = projectIndexOf([projNode("4", "diy"), projNode("1", "cops")]);
    const tabs = [tab(uri("4", "a")), tab(uri("1", "x")), tab(uri("4", "b")), tab(uri("1", "y"))];
    const gs = groupByProject(tabs, idx);
    expect(gs.map((g) => g.project?.id)).toEqual(["4", "1"]);
    expect(gs[0]!.tabs.map((t) => t.ctx)).toEqual([uri("4", "a"), uri("4", "b")]);
    expect(gs[1]!.tabs.map((t) => t.ctx)).toEqual([uri("1", "x"), uri("1", "y")]);
    // 组头拿到的就是索引里的显示名
    expect(gs[0]!.project?.label).toBe("diy");
  });

  it("树里查不到的项目：退化 id 作显示名（不丢 tab）", () => {
    const gs = groupByProject([tab(uri("9", "z"))], new Map());
    expect(gs).toHaveLength(1);
    expect(gs[0]!.project).toEqual({ id: "9", label: "9" });
    expect(gs[0]!.tabs).toHaveLength(1);
  });

  it("无项目归属的 tab（ctx 为空）：归到一个 project=null 的组，排在其首次出现的位置", () => {
    const idx = projectIndexOf([projNode("4", "diy")]);
    const gs = groupByProject([tab(null), tab(uri("4", "a"))], idx);
    expect(gs.map((g) => g.project?.id ?? null)).toEqual([null, "4"]);
  });

  it("同一任务的多个页面 tab（子页面共享 ctx）永远同组、保持相邻", () => {
    const idx = projectIndexOf([projNode("4", "diy")]);
    const a = uri("4", "a");
    const tabs = [
      { key: `task-run:${a}`, pageId: "task-run", ctx: a },
      { key: `lab:${a}`, pageId: "lab", ctx: a },
      tab(uri("1", "x")),
    ];
    const gs = groupByProject(tabs, idx);
    expect(gs[0]!.tabs.map((t) => t.key)).toEqual([`task-run:${a}`, `lab:${a}`]);
  });

  it("内容不变 → 返回同一数组引用；对象换了 / 文案变了 → 换新（nav 的 DOM 复用判据）", () => {
    const idx = projectIndexOf([projNode("4", "diy")]);
    const t1 = tab(uri("4", "a"));
    const a = groupByProject([t1], idx);
    expect(groupByProject([t1], idx)).toBe(a); // 同一批对象 → 复用（否则 nav 每次树刷新都重建）

    // key 不变而对象已换（任务改父 → tabStore 换新 item）→ 必须换新，不能把旧缩进端上来
    const t1b = tab(uri("4", "a"));
    const c = groupByProject([t1b], idx);
    expect(c).not.toBe(a);
    expect(c[0]!.tabs[0]).toBe(t1b);

    // 组头文案变了也要换新
    const idx2 = projectIndexOf([projNode("4", "diy（改名）")]);
    expect(groupByProject([t1], idx2)).not.toBe(c);
  });

  it("置顶（##356 ②）：组内置顶项进前缀、其余保序、pinnedCount = 前缀条数；组序只由输入顺序决定", () => {
    const idx = projectIndexOf([projNode("4", "diy"), projNode("1", "cops")]);
    const a = tab(uri("4", "a"));
    const b = tab(uri("4", "b"));
    const x = tab(uri("1", "x"));
    const y = tab(uri("1", "y"));

    // ① 未分区的输入（置顶项在中间）：组内被提到前缀，组序仍是「4 先于 1」
    const raw = groupByProject([a, x, b, y], idx, new Set([b.key, y.key]));
    expect(raw.map((g) => g.project?.id)).toEqual(["4", "1"]);
    expect(raw[0]!.tabs.map((t) => t.ctx)).toEqual([uri("4", "b"), uri("4", "a")]);
    expect(raw[1]!.tabs.map((t) => t.ctx)).toEqual([uri("1", "y"), uri("1", "x")]);
    expect(raw.map((g) => g.pinnedCount)).toEqual([1, 1]);

    // ② 已分区的输入（App 喂 navTabs().all：置顶项已固定在前）：
    //    组序跟着变成「含置顶项的组在前」—— 组是整体，整组跟着走（##302 与 ##356 的取舍点）
    const fed = groupByProject([b, x, a, y], idx, new Set([b.key, y.key]));
    expect(fed.map((g) => g.project?.id)).toEqual(["4", "1"]);
    expect(fed[0]!.tabs.map((t) => t.ctx)).toEqual([uri("4", "b"), uri("4", "a")]);
    expect(fed[0]!.pinnedCount).toBe(1);

    // ③ 组序只由输入顺序决定：把「1/x」挪到最前，则 1 组在前（置顶集合不参与组序）
    const swapped = groupByProject([x, y, a, b], idx, new Set([b.key, y.key]));
    expect(swapped.map((g) => g.project?.id)).toEqual(["1", "4"]);
  });

  it("不传置顶集合 / 没有置顶项：pinnedCount = 0，顺序原样（默认行为不变）", () => {
    const idx = projectIndexOf([projNode("4", "diy")]);
    const tabs = [tab(uri("4", "a")), tab(uri("4", "b"))];
    expect(groupByProject(tabs, idx)[0]!.pinnedCount).toBe(0);
    expect(groupByProject(tabs, idx, new Set<string>())[0]!.tabs.map((t) => t.ctx)).toEqual([uri("4", "a"), uri("4", "b")]);
    // 置顶集合里是**别的组**的 key：本组不受影响
    const other = groupByProject(tabs, idx, new Set([tab(uri("1", "x")).key]))[0]!;
    expect(other.pinnedCount).toBe(0);
    expect(other.tabs.map((t) => t.ctx)).toEqual([uri("4", "a"), uri("4", "b")]);
  });

  it("置顶条数变化 → 换新结果（分隔线位置跟着变，DOM 才会重排）", () => {
    const idx = projectIndexOf([projNode("4", "diy")]);
    const a = tab(uri("4", "a"));
    const b = tab(uri("4", "b"));
    const base = groupByProject([a, b], idx, new Set<string>());
    const pinned = groupByProject([a, b], idx, new Set([b.key]));
    expect(pinned).not.toBe(base);
    expect(pinned[0]!.pinnedCount).toBe(1);
  });

  it("项目色由 id 派生：确定、同 id 同色、不同 id 不同色", () => {
    for (const id of ["1", "4", "8", "12", "abc"]) {
      expect(projectHue(id)).toBe(projectHue(id));
      expect(projectHue(id)).toBeGreaterThanOrEqual(0);
      expect(projectHue(id)).toBeLessThan(360);
      expect(projectColor(id)).toBe(projectColor(id));
      expect(projectColor(id)).toMatch(/^oklch\(70% 0\.13 \d+\)$/);
    }
    const hues = new Set(["1", "2", "3", "4", "5", "6", "7", "8"].map(projectHue));
    expect(hues.size).toBeGreaterThan(5); // 相邻 id 不该全撞在一起
  });
});
