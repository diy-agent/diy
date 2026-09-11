// tests/core/task-tree.test.ts
// 🎯 意图测试：任务树构建、父子链接、文本渲染
//    数据在隔离 DIY_HOME，不碰生产

import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { loadTaskTree, renderTreeText } from "../../src/main/core/task-tree";
import { createProject } from "../../src/main/core/project";

// ═══════════════════════════════════════
// Helper: 在测试目录下创建任务文件
//    uri = projects/<pid>/tasks/<tid>，project 由路径推导，不写 frontmatter
// ═══════════════════════════════════════

function makeTask(
  uri: string,
  overrides: Partial<{
    title: string;
    state: string;
    parent: string;
    body: string;
  }> = {},
): void {
  const dir = join(diyHome(), uri);
  mkdirSync(dir, { recursive: true });

  const lines = ["---"];
  if (overrides.title) lines.push(`title: ${overrides.title}`);
  if (overrides.state) lines.push(`state: ${overrides.state}`);
  if (overrides.parent) lines.push(`parent: ${overrides.parent}`);
  lines.push("---");
  if (overrides.body) lines.push(overrides.body);

  writeFileSync(join(dir, "AGENTS.md"), lines.join("\n"), "utf-8");
}

// ═══════════════════════════════════════
// Setup: 创建两个 project + 任务数据
// ═══════════════════════════════════════

let WORK = "";
let HOME = "";
beforeAll(() => {
  WORK = createProject(join(diyHome(), "repos", "work-project"), { label: "工作" });
  HOME = createProject(join(diyHome(), "repos", "home-project"), { label: "个人" });

  makeTask(`projects/${WORK}/tasks/1`, { title: "写周报", state: "pending" });
  makeTask(`projects/${WORK}/tasks/2`, {
    title: "修 Bug",
    state: "active",
    parent: `projects/${WORK}/tasks/1`,
  });
  makeTask(`projects/${WORK}/tasks/3`, {
    title: "发 PR",
    state: "done",
    parent: `projects/${WORK}/tasks/1`,
  });
  makeTask(`projects/${HOME}/tasks/1`, { title: "缴费", state: "pending" });
});

// ═══════════════════════════════════════
// loadTaskTree (全部模式)
// ═══════════════════════════════════════

describe("loadTaskTree 全部模式", () => {
  it("返回 project 下所有顶层任务（含子任务）", () => {
    const tree = loadTaskTree();
    const work = tree.find((n) => n.project === WORK)!;
    // 顶层：只有 task-1（task-2 和 task-3 是 task-1 的子任务）
    expect(work!.children.length).toBe(1);
    // task-1 下有 2 个子任务
    const t1 = work!.children[0]!;
    expect(t1.children.length).toBe(2);
    const childUris = t1.children.map((c) => c.uri);
    expect(childUris).toContain(`projects/${WORK}/tasks/2`);
    expect(childUris).toContain(`projects/${WORK}/tasks/3`);
  });
});

// ═══════════════════════════════════════
// 父子链接
// ═══════════════════════════════════════

describe("父子链接", () => {
  it("子任务挂在父任务下，不在 project 顶层", () => {
    const tree = loadTaskTree();
    const work = tree.find((n) => n.project === WORK)!;

    const t1 = work!.children.find((c) => c.uri === `projects/${WORK}/tasks/1`)!;
    expect(t1.children.length).toBe(2);

    const childUris = t1.children.map((c) => c.uri);
    expect(childUris).toContain(`projects/${WORK}/tasks/2`);
    expect(childUris).toContain(`projects/${WORK}/tasks/3`);
  });

  it("无父任务的任务仍在 project 顶层", () => {
    const tree = loadTaskTree();
    const work = tree.find((n) => n.project === WORK)!;
    const topLevel = work!.children.filter((c) => c.parentUri === undefined || c.parentUri === "");
    expect(topLevel.length).toBe(1); // 只有 task-1
  });
});

// ═══════════════════════════════════════
// renderTreeText
// ═══════════════════════════════════════

describe("renderTreeText", () => {
  it("渲染结果可读", () => {
    const tree = loadTaskTree();
    const text = renderTreeText(tree);

    // 包含 project 名称
    expect(text).toContain("工作");
    expect(text).toContain("个人");

    // 包含全部任务
    expect(text).toContain(`projects/${WORK}/tasks/1`);
    expect(text).toContain(`projects/${WORK}/tasks/2`);
    expect(text).toContain(`projects/${WORK}/tasks/3`);
  });
});

// ═══════════════════════════════════════
// home project
// ═══════════════════════════════════════

describe("home project", () => {
  it("home 有 task-1", () => {
    const tree = loadTaskTree();
    const home = tree.find((n) => n.project === HOME)!;
    expect(home.children.length).toBe(1);
    expect(home.children[0]?.uri).toBe(`projects/${HOME}/tasks/1`);
  });
});