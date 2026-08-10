// tests/core/task.test.ts
// 🎯 意图测试：任务 CRUD 全链路 + 校验逻辑
//    所有数据在 /tmp/diy-desktop-test-xxx/，不碰生产

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { saveState } from "../../src/main/core/state";
import {
  createTask,
  updateTask,
  deleteTask,
  listTasks,
  ValidationError,
} from "../../src/main/core/task";

// Arrange: 所有测试共享的 subject 注册
const SUBJECT = "~/test-work";
beforeAll(() => {
  saveState({ subjects: new Map([[SUBJECT, { label: "测试工作" }]]) });
});

// ═══════════════════════════════════════
// createTask
// ═══════════════════════════════════════

describe("createTask", () => {
  it("创建后文件存在、内容正确、自动 star", () => {
    const uri = createTask({ title: "测试任务", subject: SUBJECT });

    const fp = join(diyHome(), "task", uri, "AGENTS.md");
    expect(existsSync(fp)).toBe(true);

    const content = readFileSync(fp, "utf-8");
    expect(content).toContain("title: 测试任务");
    expect(content).toContain("state: pending");
    expect(content).toContain("subject: " + SUBJECT);

    // star symlink 已创建
    const starLink = join(diyHome(), "star", uri.replace(/\//g, "__"));
    expect(existsSync(starLink)).toBe(true);
  });

  it("uri 格式为 local/<base36-timestamp>", () => {
    const uri = createTask({ title: "URI格式", subject: SUBJECT });
    expect(uri).toMatch(/^local\/[0-9a-z]+$/);
  });

  it("空标题抛出 ValidationError", () => {
    expect(() => createTask({ title: "", subject: SUBJECT })).toThrow(ValidationError);
  });

  it("title 超过 200 字符时报错", () => {
    const longTitle = "x".repeat(201);
    expect(() => createTask({ title: longTitle, subject: SUBJECT })).toThrow(ValidationError);
  });

  it("未注册的 subject 抛出错误", () => {
    expect(() => createTask({ title: "任务", subject: "~/unknown" })).toThrow(ValidationError);
  });

  it("不存在的 parent 抛出错误", () => {
    expect(() =>
      createTask({
        title: "子任务",
        subject: SUBJECT,
        parent: "local/nonexist",
      }),
    ).toThrow(ValidationError);
  });

  it("detail 和 body 可正确写入", () => {
    const uri = createTask({
      title: "带详情",
      subject: SUBJECT,
      detail: "详细描述",
      body: "# Markdown 正文",
    });

    const content = readFileSync(join(diyHome(), "task", uri, "AGENTS.md"), "utf-8");
    expect(content).toContain("detail: 详细描述");
    expect(content).toContain("# Markdown 正文");
  });

  it("ValidationError 包含全部错误字段", () => {
    try {
      createTask({ title: "", subject: "" });
      // 不应到达此处
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const ve = e as ValidationError;
      expect(ve.errors.length).toBeGreaterThanOrEqual(2);
      const fields = ve.errors.map((e) => e.field);
      expect(fields).toContain("title");
      expect(fields).toContain("subject");
    }
  });
});

// ═══════════════════════════════════════
// updateTask
// ═══════════════════════════════════════

describe("updateTask", () => {
  let uri: string;

  beforeAll(() => {
    uri = createTask({ title: "原标题", subject: SUBJECT });
  });

  it("更新 title 后文件内容变更", () => {
    updateTask(uri, { title: "新标题" });

    const content = readFileSync(join(diyHome(), "task", uri, "AGENTS.md"), "utf-8");
    expect(content).toContain("title: 新标题");
    expect(content).not.toContain("原标题");
  });

  it("更新 state 后文件内容变更", () => {
    updateTask(uri, { state: "done" });

    const content = readFileSync(join(diyHome(), "task", uri, "AGENTS.md"), "utf-8");
    expect(content).toContain("state: done");
  });

  it("不存在的任务抛出 Error", () => {
    expect(() => updateTask("nonexistent", { title: "新" })).toThrow();
  });

  it("无效 state 值抛出 ValidationError", () => {
    expect(() => updateTask(uri, { state: "invalid_state" })).toThrow(ValidationError);
  });
});

// ═══════════════════════════════════════
// deleteTask
// ═══════════════════════════════════════

describe("deleteTask", () => {
  it("删除后目录和文件都不存在", () => {
    const uri = createTask({ title: "待删除", subject: SUBJECT });
    const dir = join(diyHome(), "task", uri);
    expect(existsSync(dir)).toBe(true);

    deleteTask(uri);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("不存在的任务不抛异常", () => {
    expect(() => deleteTask("nonexistent")).not.toThrow();
  });
});

// ═══════════════════════════════════════
// listTasks
// ═══════════════════════════════════════

describe("listTasks", () => {
  it("列出所有已创建的任务（不传 subject）", () => {
    // 前面的 createTask 测试已经创建了若干任务
    const all = listTasks();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("按 URI 前缀筛选", () => {
    const all = listTasks("local");
    expect(all.length).toBeGreaterThanOrEqual(1);
    all.forEach((uri) => {
      expect(uri.startsWith("local/")).toBe(true);
    });
  });

  it("不存在的 URI 前缀返回空数组", () => {
    expect(listTasks("nonexistent")).toEqual([]);
  });
});
