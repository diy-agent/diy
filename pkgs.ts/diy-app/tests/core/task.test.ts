// tests/core/task.test.ts
// 🎯 意图测试：任务 CRUD 全链路 + 校验逻辑
//    所有数据在隔离 DIY_HOME（/tmp/...），不碰生产

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome, getTask } from "../../src/main/core/state";
import {
  createTask,
  updateTask,
  MIN_BODY_LENGTH,
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

  it("内容（body）写在 frontmatter 之后的正文区", () => {
    const uri = createTask({ title: "带内容", project: PROJECT, body: "# Markdown 正文" });

    const content = readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8");
    // 内容在第二个 --- 之后（正文区），不在 frontmatter 里
    const afterFrontmatter = content.split("---\n").slice(2).join("---\n");
    expect(afterFrontmatter).toContain("# Markdown 正文");
    expect(getTask(uri)?.body).toBe("# Markdown 正文");
  });

  it("不再写 detail 字段（同义的第二内容槽已下线）", () => {
    const uri = createTask({ title: "只有内容", project: PROJECT, body: "内容" });
    const content = readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8");
    expect(content).not.toContain("detail");
    expect(getTask(uri)?.body).toBe("内容");
  });

  it("多行内容往返无损（空行 / 长行 / 换行不被改写）", () => {
    const longLine = "1. 第一条描述特意写得很长以超过 js-yaml 默认的 80 列折叠宽度，确保序列化不会把这行拆成多行";
    const body = `# 需求\n\n${longLine}\n2. 第二条\n\n# 测试\n\n18/18 通过`;
    const uri = createTask({ title: "多行内容", project: PROJECT, body });

    expect(getTask(uri)?.body).toBe(body);

    // update 路径同样无损
    updateTask(uri, { body: body + "\n\n# 补充\n\n新增段落同样很长以验证更新路径的序列化配置保持一致" });
    const got = getTask(uri)!.body;
    expect(got).toContain("# 补充");
    expect(got.startsWith("# 需求\n\n" + longLine)).toBe(true);
  });

  it("frontmatter 长行不被折叠（lineWidth:-1，保护用户自定义字段）", () => {
    // yaml.dump 默认 80 列会把长标量折成多行，往返后值里被插入换行 —— 对用户写的数据是破坏
    const long = "很长的一段备注".repeat(30);
    const uri = createTask({ title: "长字段", project: PROJECT });
    const fp = join(diyHome(), uri, "AGENTS.md");
    writeFileSync(fp, `---\ntitle: 长字段\nstate: pending\nnote: ${long}\n---\n正文\n`, "utf-8");

    updateTask(uri, { state: "done" });

    const raw = readFileSync(fp, "utf-8");
    const noteLine = raw.split("\n").find((l) => l.startsWith("note:"))!;
    expect(noteLine).toContain(long); // 未被折成多行
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
// 正文长度守卫（防误清空）
//   实证事故：`task edit <uri> --body ""` 静默清空整篇正文且不可恢复。
//   过短/空白一律拒绝；未指定 body 时不受影响（编辑其他字段照旧）。
// ═══════════════════════════════════════

describe("updateTask 正文最小长度", () => {
  let uri: string;

  beforeEach(() => {
    uri = createTask({ title: "有正文的任务", project: PROJECT });
    updateTask(uri, { body: "原始正文内容，足够长以通过校验" });
  });

  const readBody = () => readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8");

  it("空串被拒绝，且原正文不被清空", () => {
    expect(() => updateTask(uri, { body: "" })).toThrow(ValidationError);
    expect(readBody()).toContain("原始正文内容");
  });

  it("纯空白被拒绝（按 trim 后长度判定）", () => {
    expect(() => updateTask(uri, { body: " ".repeat(40) })).toThrow(ValidationError);
    expect(() => updateTask(uri, { body: "\n\n\t  \n" })).toThrow(ValidationError);
    expect(readBody()).toContain("原始正文内容");
  });

  it("长度 9 被拒，长度 10 通过（边界）", () => {
    expect(() => updateTask(uri, { body: "123456789" })).toThrow(ValidationError);
    updateTask(uri, { body: "1234567890" });
    expect(readBody()).toContain("1234567890");
  });

  it("不传 body（只改标题/状态）不受守卫影响", () => {
    updateTask(uri, { title: "改标题" });
    updateTask(uri, { state: "done" });
    const content = readBody();
    expect(content).toContain("title: 改标题");
    expect(content).toContain("state: done");
    expect(content).toContain("原始正文内容");
  });

  it("报错信息里带上最小长度（调用方能自解释）", () => {
    try {
      updateTask(uri, { body: "短" });
      throw new Error("应当抛出 ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const msgs = (err as InstanceType<typeof ValidationError>).errors.map((e) => e.msg).join(" ");
      expect(msgs).toContain(String(MIN_BODY_LENGTH));
    }
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
    updateTask(uri, { body: "改过的正文（足够长，通过最小长度校验）" });

    const content = readFileSync(fp, "utf-8");
    expect(content).toContain("source_type: local");
    expect(content).toContain("source_uri: local/task/13");
    expect(content).toContain("title: 改标题");
    expect(content).toContain("改过的正文");
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

    updateTask(uri, { body: "换一段新的正文，长度足够通过校验" });

    const content = readFileSync(fp, "utf-8");
    expect(content).toContain("priority: low");
    expect(content).toContain("换一段新的正文");
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