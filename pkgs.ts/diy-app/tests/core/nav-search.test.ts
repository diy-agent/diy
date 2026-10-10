// tests/core/nav-search.test.ts
// 🎯 nav ⌘K 快速打开：搜索与排序规则（纯函数，无 DOM / 无 Electron）
//
// 这些用例守的是「弹层里第一条是不是用户想找的那条」——肉眼看列表"有结果"很容易，
// 但排错了就等于每次都要用方向键补救。真实踩点：编号命中被正文命中挤到后面。

import { describe, it, expect } from "vitest";
import {
  NAV_HIT_RANK,
  NAV_SEARCH_LIMIT,
  flattenTasks,
  searchTaskHits,
  searchTasksOf,
} from "../../src/shared/nav-search";
import type { TaskListNode } from "../../src/shared/task-list";

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

const project = (children: TaskListNode[]): TaskListNode => ({
  kind: "project",
  project: "1",
  title: "项目一",
  children,
});

const nums = (ns: TaskListNode[]) => ns.map((n) => n.num);

describe("nav-search：命中与排序", () => {
  it("空查询返回空（不把整棵树倒出来）", () => {
    expect(searchTaskHits([project([task("1")])], "")).toEqual([]);
    expect(searchTaskHits([project([task("1")])], "   ")).toEqual([]);
  });

  it("编号精确命中压过标题子串命中", () => {
    const tree = [project([task("12", { title: "别的" }), task("3", { title: "关于 12 的说明" })])];
    const hits = searchTaskHits(tree, "12");
    expect(nums(hits.map((h) => h.node))).toEqual(["12", "3"]);
    expect(hits[0]!.rank).toBe(NAV_HIT_RANK.numExact);
  });

  it("`#12` 也能精确命中编号", () => {
    const hits = searchTaskHits([project([task("12")])], "#12");
    expect(nums(hits.map((h) => h.node))).toEqual(["12"]);
    expect(hits[0]!.rank).toBe(NAV_HIT_RANK.numExact);
  });

  it("编号前缀命中排在标题命中之前", () => {
    const tree = [project([task("7", { title: "复盘 1 号方案" }), task("12"), task("199")])];
    const hits = searchTaskHits(tree, "1");
    expect(nums(hits.map((h) => h.node))).toEqual(["12", "199", "7"]);
    expect(hits[2]!.rank).toBe(NAV_HIT_RANK.titleSub);
  });

  it("非数字查询不触发编号档（num 是数字也不当前缀）", () => {
    // 搜 "task"：uri 里含 task → 字段命中；不该因为 num="12" 而进编号档
    const hits = searchTaskHits([project([task("12", { uri: "projects/1/tasks/12" })])], "task");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rank).toBe(NAV_HIT_RANK.field);
  });

  it("标题前缀 > 标题子串", () => {
    const tree = [project([task("1", { title: "复盘：nav 搜索" }), task("2", { title: "nav 搜索弹层" })])];
    const hits = searchTaskHits(tree, "nav");
    expect(nums(hits.map((h) => h.node))).toEqual(["2", "1"]);
  });

  it("正文命中恒排最后，且带片段", () => {
    const tree = [
      project([
        task("1", { title: "别的", body: "这里提到 nav 搜索一次" }),
        task("2", { title: "nav 搜索弹层" }),
      ]),
    ];
    const hits = searchTaskHits(tree, "nav");
    expect(nums(hits.map((h) => h.node))).toEqual(["2", "1"]);
    expect(hits[1]!.rank).toBe(NAV_HIT_RANK.body);
    expect(hits[1]!.snippet?.match).toBe("nav");
    expect(hits[0]!.snippet).toBeNull();
  });

  it("同档按 updated 降序，缺 updated 垫底", () => {
    const tree = [
      project([
        task("1", { title: "nav a", updated: "2026-01-01T00:00:00.000Z" }),
        task("2", { title: "nav b", updated: "2026-05-01T00:00:00.000Z" }),
        task("3", { title: "nav c" }),
      ]),
    ];
    expect(nums(searchTaskHits(tree, "nav").map((h) => h.node))).toEqual(["2", "1", "3"]);
  });

  it("递归下钻：子任务同样可被搜到；项目节点本身不进结果", () => {
    const tree = [project([task("1", { title: "父", children: [task("2", { title: "nav 子任务" })] })])];
    const hits = searchTaskHits(tree, "nav");
    expect(nums(hits.map((h) => h.node))).toEqual(["2"]);
  });

  it("searchTaskHits 返回全量、不截断（底部「N / 共 M」计数的基础，RV-4）", () => {
    const tree = [project([task("1", { title: "nav" }), task("2", { title: "nav" }), task("3", { title: "nav" })])];
    const all = searchTaskHits(tree, "nav");
    expect(all).toHaveLength(3);
    // 展示上限由调用方按 NAV_SEARCH_LIMIT 切片 —— 取排序前段（任务号升序兜底）
    expect(nums(all.slice(0, 2).map((h) => h.node))).toEqual(["1", "2"]);
    expect(NAV_SEARCH_LIMIT).toBeGreaterThan(0);
  });

  it("searchTasksOf（已平铺）与 searchTaskHits（整树）结果一致", () => {
    const tree = [project([task("1", { title: "nav" }), task("2", { title: "nav 子", children: [task("3", { title: "nav 孙" })] })])];
    const viaTree = searchTaskHits(tree, "nav").map((h) => h.uri);
    const viaFlat = searchTasksOf(flattenTasks(tree), "nav").map((h) => h.uri);
    expect(viaFlat).toEqual(viaTree);
    expect(viaFlat).toHaveLength(3);
  });

  it("flattenTasks 不假设「根恒为项目」：顶层直接挂的 task 也收录（R3-4）", () => {
    // 现实里任务树根恒为项目，但 flattenTasks 是 shared/ 的通用纯函数 ——
    // 它只该按 kind 判，不该靠"根一定是 project"这个外部前提成立。
    const forest = [project([task("1", { title: "nav 项目下" })]), task("2", { title: "nav 顶层" })];
    expect(nums(flattenTasks(forest))).toEqual(["1", "2"]);
    expect(nums(searchTaskHits(forest, "nav").map((h) => h.node))).toEqual(["1", "2"]);
  });

  it("项目节点本身不进结果（结果单位是任务/会话）", () => {
    const tree = [project([task("1", { title: "nav" })])];
    expect(nums(flattenTasks(tree))).toEqual(["1"]);
  });

  it("没有 uri 的任务不进结果（打不开会话的死项）", () => {
    const noUri: TaskListNode = { kind: "task", num: "9", title: "nav 无 URI", children: [] };
    const tree = [project([noUri, task("1", { title: "nav 有 URI" })])];
    const hits = searchTaskHits(tree, "nav");
    expect(nums(hits.map((h) => h.node))).toEqual(["1"]);
    expect(hits[0]!.uri).toBe("projects/1/tasks/1"); // NavHit.uri 是必填 string
  });
});
