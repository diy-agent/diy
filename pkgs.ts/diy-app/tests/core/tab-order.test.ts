// tests/core/tab-order.test.ts — 打开列表的排序与缩进（纯函数）
//
// 场景来源：先开 a/b/c、再开 a，侧栏里两个 task-run tab 原先**平级并列**，
// 看不出父子关系。两条规则：
//   ① 排序：新 tab 插到「最近已打开祖先」之后 → 父子链相邻
//   ② 缩进：层级 = 已打开的祖先个数 → 只在祖先开着时缩进（否则指向不存在的父）
import { describe, expect, it } from "vitest";
import {
  insertionIndex,
  normalizeOrder,
  pageParentKeyOf,
  taskIndentOf,
  type TabLike,
} from "../../src/shared/tab-order";

const A = "projects/1/tasks/a";
const B = "projects/1/tasks/b";
const C = "projects/1/tasks/c";
const X = "projects/1/tasks/x";

/** 任务 tab（ancestors = 任务祖先链，从根到直接父） */
const task = (uri: string, ancestors?: string[]): TabLike => ({
  key: `task-run:${uri}`,
  pageId: "task-run",
  ctx: uri,
  taskAncestors: ancestors,
});

/** 页面注册表的 parentPage 查询（测试里只关心 lab → task-run） */
const parentPageOf = (pid: string) => (pid === "lab" ? "task-run" : undefined);
const lab = (uri: string): TabLike => ({ key: `lab:${uri}`, pageId: "lab", ctx: uri, parent: `task-run:${uri}` });

describe("taskIndentOf —— 层级 = 已打开的祖先个数", () => {
  it("祖先没开 → 不缩进（不指向不存在的父）", () => {
    const c = task(C, [A, B]);
    expect(taskIndentOf(c, [c])).toBe(0);
  });

  it("直接父开着 → 1 级", () => {
    const b = task(B, [A]);
    const c = task(C, [A, B]);
    expect(taskIndentOf(c, [b, c])).toBe(1);
  });

  it("祖父与父都开着 → 2 级", () => {
    const a = task(A);
    const b = task(B, [A]);
    const c = task(C, [A, B]);
    expect(taskIndentOf(c, [a, b, c])).toBe(2);
  });

  it("只有祖父开着（父没开）→ 仍算 1 级（相对已开项表达从属）", () => {
    const a = task(A);
    const c = task(C, [A, B]);
    expect(taskIndentOf(c, [a, c])).toBe(1);
  });

  it("顶级任务与无关任务 → 0", () => {
    expect(taskIndentOf(task(A), [task(A)])).toBe(0);
    expect(taskIndentOf(task(X), [task(A)])).toBe(0);
  });

  it("非任务 tab（无 ancestors）→ 0", () => {
    expect(taskIndentOf(lab(A), [lab(A), task(A)])).toBe(0);
  });
});

describe("insertionIndex —— 排序规则的唯一实现", () => {
  it("场景：先开 a/b/c，再开 a → a 插到 a/b/c **之前**（相邻）", () => {
    const c = task(C, [A, B]);
    const a = task(A);
    expect(insertionIndex(a, [c], parentPageOf)).toBe(0);
  });

  it("场景：a 已开，再开 a/b/c → 插到 a 之后（相邻）", () => {
    const a = task(A);
    const c = task(C, [A, B]);
    expect(insertionIndex(c, [a], parentPageOf)).toBe(1);
  });

  it("跨过整个家族：a 已开 + 已有兄弟 b，再开 c → 排在 b 之后", () => {
    const a = task(A);
    const b = task(B, [A]);
    const c = task(C, [A, B]);
    expect(insertionIndex(c, [a, b], parentPageOf)).toBe(2);
  });

  it("插到**最近**已打开祖先之后（直接父优先于祖父）", () => {
    const a = task(A);
    const b = task(B, [A]);
    const c = task(C, [A, B]);
    expect(insertionIndex(c, [a, b, task(X)], parentPageOf)).toBe(2); // 紧跟 b，不是紧跟 a
  });

  it("祖先都没开 → 队尾", () => {
    const c = task(C, [A, B]);
    expect(insertionIndex(c, [task(X)], parentPageOf)).toBe(1);
  });

  it("页面子页面优先：lab 紧跟其 task-run 父之后", () => {
    const a = task(A);
    const l = lab(A);
    expect(insertionIndex(l, [a, task(X)], parentPageOf)).toBe(1);
  });

  it("空列表 → 0", () => {
    expect(insertionIndex(task(A), [], parentPageOf)).toBe(0);
  });
});

describe("normalizeOrder —— 历史数据也要规范化", () => {
  it("散开的父子被收拢，父在前", () => {
    const c = task(C, [A, B]);
    const a = task(A);
    const x = task(X);
    const out = normalizeOrder([c, x, a], parentPageOf);
    expect(out.map((t) => t.ctx)).toEqual([X, A, C]);
  });

  it("同族内保持原相对顺序（稳定，不打乱用户顺序）", () => {
    const a = task(A);
    const b = task(B, [A]);
    const c = task(C, [A]);
    const out = normalizeOrder([c, a, b], parentPageOf);
    // a 在前；c、b 都是 a 的子且原顺序 c 先于 b
    expect(out.map((t) => t.ctx)).toEqual([A, C, B]);
  });

  it("页面子页面紧跟父（lab 与 task-run 相邻）", () => {
    const a = task(A);
    const l = lab(A);
    const x = task(X);
    const out = normalizeOrder([l, x, a], parentPageOf);
    expect(out.map((t) => t.key)).toEqual([`task-run:${X}`, `task-run:${A}`, `lab:${A}`]);
  });

  it("**绝不丢 tab**：环 / 异常数据也全部保留", () => {
    const a: TabLike = { key: "task-run:x", pageId: "task-run", ctx: "x", taskAncestors: ["y"] };
    const b: TabLike = { key: "task-run:y", pageId: "task-run", ctx: "y", taskAncestors: ["x"] };
    const out = normalizeOrder([a, b], parentPageOf);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((t) => t.key))).toEqual(new Set(["task-run:x", "task-run:y"]));
  });

  it("空列表 / 单项列表原样", () => {
    expect(normalizeOrder([], parentPageOf)).toEqual([]);
    const one = task(A);
    expect(normalizeOrder([one], parentPageOf)).toEqual([one]);
  });
});

describe("pageParentKeyOf —— 页面层次判据（与排序同源）", () => {
  it("显式 parent 优先", () => {
    expect(pageParentKeyOf(lab(A), parentPageOf)).toBe(`task-run:${A}`);
  });

  it("无 parent 时由注册表 parentPage 推（ctx 相同）", () => {
    const l: TabLike = { key: `lab:${A}`, pageId: "lab", ctx: A };
    expect(pageParentKeyOf(l, parentPageOf)).toBe(`task-run:${A}`);
  });

  it("无父页面 → undefined", () => {
    expect(pageParentKeyOf(task(A), parentPageOf)).toBeUndefined();
  });
});
