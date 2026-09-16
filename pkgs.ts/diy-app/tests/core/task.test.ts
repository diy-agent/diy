// tests/core/task.test.ts
// 🎯 意图测试：任务 CRUD 全链路 + 校验逻辑
//    所有数据在隔离 DIY_HOME（/tmp/...），不碰生产

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome, getTask } from "../../src/main/core/state";
import {
  createTask,
  updateTask,
  deleteTask,
  listTasks,
  ValidationError,
} from "../../src/main/core/task";
import { createProject } from "../../src/main/core/project";

// Arrange: 测试共享的真实 project（id 自动生成）
let PROJECT = "1";
beforeAll(() => {
  PROJECT = createProject(join(diyHome(), "test-work"));
});

// ═══════════════════════════════════════
// createTask
// ═══════════════════════════════════════

describe("createTask", () => {
  it("创建后文件存在、内容正确", () => {
    const uri = createTask({ title: "测试任务", project: PROJECT });

    const fp = join(diyHome(), uri, "AGENTS.md");
    expect(existsSync(fp)).toBe(true);

    const content = readFileSync(fp, "utf-8");
    expect(content).toContain("title: 测试任务");
    expect(content).toContain("state: pending");
    // 新模型 frontmatter 不写 project（project 由 URI 路径推导）
    expect(content).not.toContain("project:");
  });

  it("uri 格式为 projects/<pid>/tasks/<tid>", () => {
    const uri = createTask({ title: "URI格式", project: PROJECT });
    expect(uri).toMatch(/^projects\/\d+\/tasks\/\d+$/);
    expect(uri).toBe(`projects/${PROJECT}/tasks/` + uri.split("/").pop());
  });

  it("空标题抛出 ValidationError", () => {
    expect(() => createTask({ title: "", project: PROJECT })).toThrow(ValidationError);
  });

  it("title 超过 200 字符时报错", () => {
    const longTitle = "x".repeat(201);
    expect(() => createTask({ title: longTitle, project: PROJECT })).toThrow(ValidationError);
  });

  it("未注册的 project 抛出错误", () => {
    expect(() => createTask({ title: "任务", project: "999999" })).toThrow(ValidationError);
  });

  it("不存在的 parent 抛出错误", () => {
    expect(() =>
      createTask({
        title: "子任务",
        project: PROJECT,
        parent: "projects/1/tasks/999",
      }),
    ).toThrow(ValidationError);
  });

  it("detail 和 body 可正确写入", () => {
    const uri = createTask({
      title: "带详情",
      project: PROJECT,
      detail: "详细描述",
      body: "# Markdown 正文",
    });

    const content = readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8");
    expect(content).toContain("detail: 详细描述");
    expect(content).toContain("# Markdown 正文");
  });

  it("多行 detail 落盘为 |- 字面块且往返无损（防 >- 折叠回归）", () => {
    const longLine = "1. 第一条描述特意写得很长以超过 js-yaml 默认的 80 列折叠宽度，确保旧配置会把这行拆成多行";
    const detail = `# 需求\n\n${longLine}\n2. 第二条\n\n# 测试\n\n18/18 通过`;
    const uri = createTask({ title: "字面块", project: PROJECT, detail });

    const content = readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8");
    expect(content).toContain("detail: |-\n");
    expect(content).not.toContain("detail: >-");
    // 往返无损：空行/换行原样还原，长行未被拆
    expect(getTask(uri)?.detail).toBe(detail);

    // update 路径同样保持字面块
    updateTask(uri, { detail: detail + "\n\n# 补充\n\n新增段落同样很长以验证更新路径的序列化配置保持一致" });
    const after = readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8");
    expect(after).toContain("detail: |-\n");
    expect(getTask(uri)?.detail).toContain("# 补充");
  });

  it("ValidationError 包含全部错误字段", () => {
    try {
      createTask({ title: "", project: "" });
      // 不应到达此处
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const ve = e as ValidationError;
      expect(ve.errors.length).toBeGreaterThanOrEqual(2);
      const fields = ve.errors.map((e) => e.field);
      expect(fields).toContain("title");
      expect(fields).toContain("project");
    }
  });
});

// ═══════════════════════════════════════
// updateTask
// ═══════════════════════════════════════

describe("updateTask", () => {
  let uri: string;

  beforeAll(() => {
    uri = createTask({ title: "原标题", project: PROJECT });
  });

  it("更新 title 后文件内容变更", () => {
    updateTask(uri, { title: "新标题" });

    const content = readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8");
    expect(content).toContain("title: 新标题");
    expect(content).not.toContain("原标题");
  });

  it("更新 state 后文件内容变更", () => {
    updateTask(uri, { state: "done" });

    const content = readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8");
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
// updateTask 的字段保留原则
//   我们只负责自己管的字段；其余（用户自定义 / 外部工具写的）无权删除。
//   曾经的行为是「按白名单重建 frontmatter」，导致改一次 state 就吃掉
//   tags/priority/note/source_* —— 静默丢用户数据，故这里锁死。
// ═══════════════════════════════════════

describe("updateTask 保留非托管字段", () => {
  /** 直写一个带「用户自定义字段」的任务文件，模拟手工/外部工具创建 */
  function writeRawTask(uri: string, extraFront: string): string {
    const fp = join(diyHome(), uri, "AGENTS.md");
    writeFileSync(
      fp,
      `---\ntitle: '手工任务'\nstate: pending\n${extraFront}created: '2026-01-01T00:00:00.000Z'\nupdated: '2026-01-01T00:00:00.000Z'\n---\n原始正文\n`,
      "utf-8",
    );
    return fp;
  }

  it("用户自定义字段（tags / priority / note）在改 state 后仍在", () => {
    const uri = createTask({ title: "占位", project: PROJECT });
    const fp = writeRawTask(uri, "tags:\n  - important\n  - 前端\npriority: high\nnote: '自己加的备注'\n");

    updateTask(uri, { state: "done" });

    const content = readFileSync(fp, "utf-8");
    expect(content).toContain("state: done");
    expect(content).toContain("important");
    expect(content).toContain("前端");
    expect(content).toContain("priority: high");
    expect(content).toContain("自己加的备注");
  });

  it("source_type / source_uri（GitHub 同步将要用到）不被吃掉", () => {
    const uri = createTask({ title: "占位", project: PROJECT });
    const fp = writeRawTask(uri, "source_type: local\nsource_uri: local/task/13\n");

    updateTask(uri, { title: "改标题" });
    updateTask(uri, { body: "改正文" });

    const content = readFileSync(fp, "utf-8");
    expect(content).toContain("source_type: local");
    expect(content).toContain("source_uri: local/task/13");
    expect(content).toContain("title: 改标题");
    expect(content).toContain("改正文");
  });

  it("不再凭空写入 project（URI 是计算值，不落盘）", () => {
    const uri = createTask({ title: "占位", project: PROJECT });
    const fp = writeRawTask(uri, "");

    updateTask(uri, { state: "active" });

    expect(readFileSync(fp, "utf-8")).not.toContain("project:");
  });

  it("原有 project 字段（历史数据）也不会被本函数删掉", () => {
    // 删除该字段属于一次性数据迁移的事，不该由例行编辑顺带做
    const uri = createTask({ title: "占位", project: PROJECT });
    const fp = writeRawTask(uri, "project: '9'\n");

    updateTask(uri, { state: "done" });

    expect(readFileSync(fp, "utf-8")).toContain("project: '9'");
  });

  it("改正文（body）时自定义字段同样保留", () => {
    const uri = createTask({ title: "占位", project: PROJECT });
    const fp = writeRawTask(uri, "priority: low\n");

    updateTask(uri, { body: "换一段正文" });

    const content = readFileSync(fp, "utf-8");
    expect(content).toContain("priority: low");
    expect(content).toContain("换一段正文");
    expect(content).not.toContain("原始正文");
  });
});

// ═══════════════════════════════════════
// deleteTask
// ═══════════════════════════════════════

describe("deleteTask", () => {
  it("删除后目录和文件都不存在", () => {
    const uri = createTask({ title: "待删除", project: PROJECT });
    const dir = join(diyHome(), uri);
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
  it("列出所有已创建的任务（不传 project）", () => {
    // 前面的 createTask 测试已经创建了若干任务
    const all = listTasks();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("按 project 筛选", () => {
    const all = listTasks(PROJECT);
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("不存在的 project 返回空数组", () => {
    expect(listTasks("nonexistent")).toEqual([]);
  });
});