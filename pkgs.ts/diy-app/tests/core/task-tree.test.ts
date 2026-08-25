// tests/core/task-tree.test.ts
// 🎯 意图测试：任务树构建、父子链接、文本渲染
//    数据在 /tmp/diy-desktop-test-xxx/，不碰生产

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { diyHome, saveState } from "../../src/main/core/state";
import { loadTaskTree, renderTreeText } from "../../src/main/core/task-tree";

// ═══════════════════════════════════════
// Helper: 在测试目录下创建任务文件
// ═══════════════════════════════════════

function makeTask(
  uri: string,
  overrides: Partial<{
    title: string;
    state: string;
    project: string;
    parent: string;
    body: string;
  }> = {},
): void {
  const dir = join(diyHome(), "task", uri);
  mkdirSync(dir, { recursive: true });

  const lines = ["---"];
  if (overrides.title) lines.push(`title: ${overrides.title}`);
  if (overrides.state) lines.push(`state: ${overrides.state}`);
  if (overrides.project) lines.push(`project: ${overrides.project}`);
  if (overrides.parent) lines.push(`parent: ${overrides.parent}`);
  lines.push("---");
  if (overrides.body) lines.push(overrides.body);

  writeFileSync(join(dir, "AGENTS.md"), lines.join("\n"), "utf-8");
}

function makeStar(uri: string): void {
  const starDir = join(diyHome(), "star");
  mkdirSync(starDir, { recursive: true });
  const link = join(starDir, uri.replace(/\//g, "__"));
  if (!existsSync(link)) {
    symlinkSync(join(diyHome(), "task", uri), link);
  }
}

// ═══════════════════════════════════════
// Setup: 注册 subject + 创建任务数据
//    注意：URI 不含 ~/，subject 字段存储 ~/work
//    目录结构：task/ 下是直接子目录（URI 前缀），不是 subject 路径
// ═══════════════════════════════════════

beforeAll(() => {
  saveState({
    projects: new Map([
      ["work", { label: "工作" }],
      ["home", { label: "个人" }],
    ]),
  });

  // 创建任务，URI = 简单标识符
  makeTask("local/task-1", { title: "写周报", state: "pending", project: "work" });
  makeTask("local/task-2", {
    title: "修 Bug",
    state: "active",
    project: "work",
    parent: "local/task-1",
  });
  makeTask("local/task-3", {
    title: "发 PR",
    state: "done",
    project: "work",
    parent: "local/task-1",
  });
  makeTask("local/task-4", { title: "缴费", state: "pending", project: "home" });

  // Star 其中两个
  makeStar("local/task-1");
  makeStar("local/task-3");
});

// ═══════════════════════════════════════
// loadTaskTree (star 模式)
// ═══════════════════════════════════════

describe("loadTaskTree star 模式", () => {
  it("返回所有 subject 节点", () => {
    const tree = loadTaskTree(false);
    expect(tree.length).toBe(2);
    expect(tree[0]?.kind).toBe("project");
    expect(tree[1]?.kind).toBe("project");
  });

  it("只包含 star 过的任务，父子链接后分布在树中", () => {
    const tree = loadTaskTree(false);
    const work = tree.find((n) => n.project === "work")!;
    expect(work).toBeDefined();

    // task-1 无父任务，在顶层
    const t1 = work.children.find((c) => c.uri === "local/task-1")!;
    expect(t1).toBeDefined();

    // task-3 的 parent=task-1，在 t1.children 下
    const t3 = t1.children.find((c) => c.uri === "local/task-3")!;
    expect(t3).toBeDefined();

    // task-2 未 star，不在树中
    expect(work.children.find((c) => c.uri === "local/task-2")).toBeUndefined();
  });

  it("starred 标记为 true", () => {
    const tree = loadTaskTree(false);
    const work = tree.find((n) => n.project === "work")!;
    const t1 = work.children.find((c) => c.uri === "local/task-1")!;
    expect(t1.starred).toBe(true);
    const t3 = t1.children.find((c) => c.uri === "local/task-3")!;
    expect(t3.starred).toBe(true);
  });
});

// ═══════════════════════════════════════
// loadTaskTree (全部模式)
// ═══════════════════════════════════════

describe("loadTaskTree 全部模式", () => {
  it("返回 subject 下所有顶层任务（含子任务）", () => {
    const tree = loadTaskTree(true);
    const work = tree.find((n) => n.project === "work")!;
    // 顶层：只有 task-1（task-2 和 task-3 是 task-1 的子任务）
    expect(work!.children.length).toBe(1);
    // task-1 下有 2 个子任务
    const t1 = work!.children[0]!;
    expect(t1.children.length).toBe(2);
    const childUris = t1.children.map((c) => c.uri);
    expect(childUris).toContain("local/task-2");
    expect(childUris).toContain("local/task-3");
  });

  it("starred 标记正确", () => {
    const tree = loadTaskTree(true);
    const work = tree.find((n) => n.project === "work")!;
    const t1 = work!.children.find((c) => c.uri === "local/task-1")!;
    const t2 = t1.children.find((c) => c.uri === "local/task-2")!;
    expect(t1.starred).toBe(true);
    expect(t2.starred).toBe(false);
  });
});

// ═══════════════════════════════════════
// 父子链接
// ═══════════════════════════════════════

describe("父子链接", () => {
  it("子任务挂在父任务下，不在 subject 顶层", () => {
    const tree = loadTaskTree(true);
    const work = tree.find((n) => n.project === "work")!;

    // task-2 和 task-3 的 parent = task-1，应在 task-1.children 下
    const t1 = work!.children.find((c) => c.uri === "local/task-1")!;
    expect(t1.children.length).toBe(2);

    const childUris = t1.children.map((c) => c.uri);
    expect(childUris).toContain("local/task-2");
    expect(childUris).toContain("local/task-3");
  });

  it("无父任务的任务仍在 subject 顶层", () => {
    const tree = loadTaskTree(true);
    const work = tree.find((n) => n.project === "work")!;
    const topLevel = work!.children.filter((c) => c.parentUri === undefined || c.parentUri === "");
    expect(topLevel.length).toBe(1); // 只有 task-1
  });
});

// ═══════════════════════════════════════
// renderTreeText
// ═══════════════════════════════════════

describe("renderTreeText", () => {
  it("渲染结果可读", () => {
    const tree = loadTaskTree(false);
    const text = renderTreeText(tree);

    // 包含 subject 名称
    expect(text).toContain("工作");
    expect(text).toContain("个人");

    // 包含 star 的任务
    expect(text).toContain("local/task-1");
    expect(text).toContain("local/task-3");

    // 不包含未 star 的任务
    expect(text).not.toContain("local/task-2");
  });
});

// ═══════════════════════════════════════
// home subject（无 star 任务）
// ═══════════════════════════════════════

describe("home subject (no stars)", () => {
  it("star 模式下 home 的 children 为空", () => {
    const tree = loadTaskTree(false);
    const home = tree.find((n) => n.project === "home")!;
    expect(home.children.length).toBe(0);
  });

  it("全部模式下 home 有 task-4", () => {
    const tree = loadTaskTree(true);
    const home = tree.find((n) => n.project === "home")!;
    expect(home.children.length).toBe(1);
    expect(home.children[0]?.uri).toBe("local/task-4");
  });
});
