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
  stripHeadFromBody,
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
//   tags/note/source_* —— 静默丢用户数据，故这里锁死。
//   注：priority 后来升级为受管字段（change_type/module/priority 三兄弟），
//   但「未指定该字段的编辑不动它」的规则照旧 —— 见下面的用例。
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
    // priority 现已是受管字段：本用例额外锁死「词表外的手写值（high）不被清洗」——
    // 例行编辑没资格改用户手写的值，只有显式传该字段才动它
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
  // 自造前置：旧注释靠「前面的 createTask 测试已经建了任务」—— `--sequence.shuffle` 下
  // 那个前提不成立（本组可能先跑）。本组自己建一个，断言强度不变。
  beforeAll(() => {
    createTask({ title: "listTasks 前置任务", project: PROJECT });
  });

  it("列出所有已创建的任务（不传 project）", () => {
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
// ═══════════════════════════════════════
// 结构化字段：change_type / module / priority
//   词表真相源 = src/main/core/task-fields.ts
// ═══════════════════════════════════════

describe("结构化字段（change_type / module / priority）", () => {
  it("create 时可写入三个字段", () => {
    const uri = createTask({
      title: "带字段的任务",
      project: PROJECT,
      change_type: "fix",
      module: "agent/ui",
      priority: "P1",
    });
    const t = getTask(uri)!;
    expect(t.change_type).toBe("fix");
    expect(t.module).toBe("agent/ui");
    expect(t.priority).toBe("P1");
    expect(readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8")).toContain("change_type: fix");
  });

  it("不传就不写键（缺省 = 未设置，靠键不存在表达，而非空值噪音）", () => {
    const uri = createTask({ title: "没字段的任务", project: PROJECT });
    const raw = readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8");
    expect(raw).not.toContain("change_type:");
    expect(raw).not.toContain("module:");
    expect(raw).not.toContain("priority:");
  });

  it("module 纯空白 = 不写键（避免 `module: ''` 噪音）", () => {
    const uri = createTask({ title: "空白模块", project: PROJECT, module: "   " });
    expect(readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8")).not.toContain("module:");
  });

  it("module 两侧空白被 trim（手滑多打的空格不进数据）", () => {
    const uri = createTask({ title: "带空格", project: PROJECT, module: "  agent/ui  " });
    expect(getTask(uri)!.module).toBe("agent/ui");
  });

  it("change_type 只收词表内的值，其余报 ValidationError（写入侧严格）", () => {
    expect(() => createTask({ title: "非法类型", project: PROJECT, change_type: "bug" })).toThrow(ValidationError);
  });

  it("priority 只收 P0-P3（'high' 这类人在写标题时会写的值进不来）", () => {
    expect(() => createTask({ title: "非法优先级", project: PROJECT, priority: "high" })).toThrow(ValidationError);
    expect(() => createTask({ title: "非法优先级", project: PROJECT, priority: "p0" })).toThrow(ValidationError);
  });

  it("module 超长被拒（挡住「整段贴进来」这类误用）", () => {
    expect(() => createTask({ title: "超长模块", project: PROJECT, module: "x".repeat(200) })).toThrow(ValidationError);
  });

  it("update 可设置与清除（空字符串 = 清除，与 parent 的三态一致）", () => {
    const uri = createTask({ title: "三态", project: PROJECT, change_type: "feat", priority: "P2" });

    updateTask(uri, { change_type: "docs" });
    expect(getTask(uri)!.change_type).toBe("docs");
    expect(getTask(uri)!.priority).toBe("P2"); // 未指定的字段不动

    updateTask(uri, { priority: "" }); // 清除 → 回未定级
    expect(getTask(uri)!.priority).toBeUndefined();
    expect(readFileSync(join(diyHome(), uri, "AGENTS.md"), "utf-8")).not.toContain("priority:");

    updateTask(uri, { change_type: "" });
    expect(getTask(uri)!.change_type).toBeUndefined();
  });

  it("清除 module（空白串同样视为清除）", () => {
    const uri = createTask({ title: "清模块", project: PROJECT, module: "ui" });
    updateTask(uri, { module: "  " });
    expect(getTask(uri)!.module).toBeUndefined();
  });

  it("设置非法值时抛出 ValidationError（写入侧仍严格）", () => {
    const uri = createTask({ title: "非法更新", project: PROJECT });
    expect(() => updateTask(uri, { change_type: "nope" })).toThrow(ValidationError);
    expect(() => updateTask(uri, { priority: "P9" })).toThrow(ValidationError);
  });

  it("词表外的手写值在只改别的字段时原样保留（读侧宽容的兑现）", () => {
    const uri = createTask({ title: "手写值", project: PROJECT });
    const fp = join(diyHome(), uri, "AGENTS.md");
    writeFileSync(
      fp,
      `---\ntitle: '手工任务'\nstate: pending\npriority: high\nchange_type: bug\ncreated: '2026-01-01T00:00:00.000Z'\nupdated: '2026-01-01T00:00:00.000Z'\n---\n正文\n`,
      "utf-8",
    );

    updateTask(uri, { state: "active" });

    const raw = readFileSync(fp, "utf-8");
    expect(raw).toContain("priority: high");
    expect(raw).toContain("change_type: bug");
    // 读侧也要读得到（否则表格里这几列显示为空，用户会以为数据丢了）
    expect(getTask(uri)!.priority).toBe("high");
    expect(getTask(uri)!.change_type).toBe("bug");
  });

  it("改结构化字段不动 created（updated 才刷新）", () => {
    const uri = createTask({ title: "时间戳", project: PROJECT });
    const before = getTask(uri)!.created;
    updateTask(uri, { change_type: "perf" });
    expect(getTask(uri)!.created).toBe(before);
    expect(getTask(uri)!.updated).not.toBeUndefined();
  });
});

// ═══════════════════════════════════════
// 读写对称（##322）：整份文件剥头 / 追加 / 往返 byte-exact
//
//   背景：`--body "$(cat AGENTS.md)"` 是最自然的写法，而旧实现把整份当正文收下 —— 正文里
//   复制出一个 frontmatter，且异常自我延续（第二段头又成了正文的一部分）。历史中招：
//   ##87/##209/##224/##171/##263/##307/##293/##310/##312。
//   这里锁死三件事：① 读到的正文写回去 → 正文区逐字节不变；② 传整份文件 → 头被剥掉；
//   ③ 追加不必先读文件（消灭 read-modify-write）。
// ═══════════════════════════════════════

describe("任务文件读写对称（##322）", () => {
  const fpOf = (uri: string) => join(diyHome(), uri, "AGENTS.md");
  const rawOf = (uri: string) => readFileSync(fpOf(uri), "utf-8");
  /** 正文区 = 头之后的部分 */
  const bodyRegionOf = (raw: string) => raw.slice(raw.indexOf("---", 3) + 3);
  /** `---` 独占行数：规范的任务文件正好 2（头首尾各一行）—— 双头就是 4 */
  const sepLines = (raw: string) => raw.split("\n").filter((l) => l.trim() === "---").length;

  it("读-写往返 byte-exact：正文区逐字不变，头仍只有一个", () => {
    const body = "# 需求\n\n段落一\n\n段落二，够长以通过最小长度校验";
    const uri = createTask({ title: "往返", project: PROJECT, body });
    const before = rawOf(uri);

    const read = getTask(uri)!.body;
    expect(read).toBe(body);

    updateTask(uri, { body: read });

    const after = rawOf(uri);
    expect(bodyRegionOf(after)).toBe(bodyRegionOf(before));
    expect(after).toContain("title: 往返");
    expect(sepLines(after)).toBe(2);
  });

  it("--body 收到整份文件 → 剥头取正文，不产生双头（并回报剥离结果）", () => {
    const body = "原始正文，长度足够通过最小长度校验";
    const uri = createTask({ title: "整份", project: PROJECT, body });

    const report = updateTask(uri, { body: rawOf(uri) });

    const after = rawOf(uri);
    expect(sepLines(after)).toBe(2); // 仍只有一个头（双头污染的反面）
    expect(getTask(uri)!.body).toBe(body); // 正文没被头污染
    expect(report.body_head_stripped?.keys).toContain("title");
    // 头来自同一份文件 → 无差异（有差异才需要调用方知道）
    expect(report.body_head_stripped?.differs).toEqual([]);
  });

  it("整份文件 + 空正文 → 被最小长度守卫拒绝（剥离在校验之前，不能靠头蒙混过关）", () => {
    const uri = createTask({ title: "空正文", project: PROJECT });
    expect(() => updateTask(uri, { body: rawOf(uri) })).toThrow(ValidationError);
  });

  it("追加原语：appendBody 追加到正文末尾（空行分隔），并回报追加字符数", () => {
    const uri = createTask({ title: "追加", project: PROJECT, body: "第一段，够长通过校验" });

    const report = updateTask(uri, { appendBody: "第二段\n" });

    expect(getTask(uri)!.body).toBe("第一段，够长通过校验\n\n第二段");
    expect(report.appended_chars).toBe(3);
    expect(sepLines(rawOf(uri))).toBe(2);
  });

  it("追加到空正文：正文就是追加内容（不产生前导空行）", () => {
    const uri = createTask({ title: "空追加起点", project: PROJECT });
    updateTask(uri, { appendBody: "唯一的一段正文" });
    expect(getTask(uri)!.body).toBe("唯一的一段正文");
  });

  it("追加内容为空 → 拒绝（不静默写个空段落）", () => {
    const uri = createTask({ title: "空追加", project: PROJECT, body: "原文，够长通过校验" });
    expect(() => updateTask(uri, { appendBody: "  \n" })).toThrow(ValidationError);
    expect(getTask(uri)!.body).toBe("原文，够长通过校验");
  });

  it("追加内容若其实是整份文件 → 同样剥头（否则又复制出一个头）", () => {
    const uri = createTask({ title: "追加整份", project: PROJECT, body: "原文，够长通过校验" });
    const other = createTask({ title: "别的任务", project: PROJECT, body: "别处的正文" });

    const report = updateTask(uri, { appendBody: rawOf(other) });

    expect(sepLines(rawOf(uri))).toBe(2);
    expect(getTask(uri)!.body).toBe("原文，够长通过校验\n\n别处的正文");
    expect(report.append_head_stripped?.keys).toContain("title");
    // 回报里带**被剥掉的原文** —— 只报键名，调用方看不出丢了什么内容（##322 review R1c）
    expect(report.append_head_stripped?.head_text).toContain("title: 别的任务");
  });

  it("非托管键不会被整份文件写法吃掉（头仍归用户）", () => {
    const uri = createTask({ title: "自定义键", project: PROJECT, body: "原文，够长通过最小长度校验" });
    writeFileSync(
      fpOf(uri),
      rawOf(uri).replace("state: pending", "state: pending\nnote: '我自己加的备注'"),
      "utf-8",
    );

    updateTask(uri, { body: readFileSync(fpOf(uri), "utf-8") }); // 传整份文件（含自定义键）

    // 键与值都在（引号形式由 yaml.dump 归一，属既有行为；这里只锁"没被吃掉"）
    expect(rawOf(uri)).toContain("note: 我自己加的备注");
    expect(sepLines(rawOf(uri))).toBe(2);
  });

  it("正文里的 `---` 段落不被误判成头（未命中已知头键 → 原样保留）", () => {
    const md = "---\nfoo: bar\n---\n这是正文里的一段，够长通过最小长度校验";
    const uri = createTask({ title: "误判防护", project: PROJECT, body: "占位正文，够长通过校验" });

    updateTask(uri, { body: md });

    expect(getTask(uri)!.body).toBe(md);
    expect(sepLines(rawOf(uri))).toBe(4); // 真正的头 2 行 + 正文里自带的 2 行
  });

  // ── 判据边界（##322 review R1：并入作者自带探针 /tmp/t266-review/p322-strip-head.probe.ts 的 5 例）──
  //
  // 两条路的误判代价**不对称**：`--body` 收到整份任务文件是常态（剥头是正解）；
  // `--append-body` 收到一份**文档**是常态（Markdown 文档带 front matter 很常见，`title:` 恰是已知键）
  // ⇒ 追加用严判据（必须命中头的特征键 state/created/updated），否则文档头被静默吞掉。
  it("stripHeadFromBody 判据：真头剥 / 正文里的 --- 段落与纯自定义头一律不剥", () => {
    const cases: Array<{ name: string; input: string; strict?: boolean; expectStrip: boolean }> = [
      {
        name: "整份任务文件（真头）",
        input: `---\ntitle: 某任务\nstate: active\ncreated: 2026-01-01T00:00:00.000Z\n---\n\n## 正文\n\n内容\n`,
        expectStrip: true,
      },
      {
        // 宽判据（--body）下会剥；严格模式（--append-body）下**不剥**（追加一份文档是常态）
        name: "正文以 --- 开头 + 只有 title（文档 front matter）",
        input: `---\ntitle: 这是我的文档标题\n---\n\n上面是正文里引用的 frontmatter 示例。\n`,
        expectStrip: true,
      },
      {
        name: "同上，但严格模式（--append-body 的判据）",
        input: `---\ntitle: 这是我的文档标题\n---\n\n上面是正文里引用的 frontmatter 示例。\n`,
        strict: true,
        expectStrip: false,
      },
      {
        name: "正文以 --- 开头 + 自定义键（无已知键）",
        input: `---\nfoo: bar\nbaz: 1\n---\n\n正文\n`,
        strict: true,
        expectStrip: false,
      },
      {
        name: "markdown 分隔线 + 表格",
        input: `---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`,
        expectStrip: false,
      },
      { name: "只有 --- 一行", input: `---\n`, expectStrip: false },
      {
        name: "严格模式下真头（含 state）仍剥",
        input: `---\ntitle: 某任务\nstate: active\n---\n\n正文\n`,
        strict: true,
        expectStrip: true,
      },
    ];
    const bad: string[] = [];
    for (const c of cases) {
      const got = stripHeadFromBody(c.input, { strict: c.strict ?? false }) !== null;
      if (got !== c.expectStrip) bad.push(`${c.name}：期望剥=${c.expectStrip} 实际剥=${got}`);
    }
    expect(bad).toEqual([]);
  });

  it("--append-body 追加一份带 front matter 的文档 → 文档头**原样保留**（不静默吞掉）", () => {
    // review R1 的端到端复现（并入 /tmp/t266-review/probe-322-append-head.test.ts）：
    // 追加 `---\ntitle: 练习册答案\nnote: 手写文档\n---\n\n# 正文` 时，两行内容曾从盘上消失。
    const uri = createTask({ title: "追加文档", project: PROJECT, body: "原始正文，长度足够不会被拒。" });
    const doc = "---\ntitle: 练习册答案\nnote: 手写文档\n---\n\n# 正文\n\n1. 答案 A\n";

    const report = updateTask(uri, { appendBody: doc });
    const body = getTask(uri)!.body;

    expect(report.append_head_stripped).toBeUndefined(); // 没剥头
    expect(body).toContain("title: 练习册答案"); // 文档头逐行在
    expect(body).toContain("note: 手写文档");
    expect(body).toContain("# 正文");
    expect(sepLines(rawOf(uri))).toBe(4); // 任务自己的头 2 行 + 文档自带的 2 行（是正文，不是双头）
  });

  it("判据不对称：同一份文档 `--body` 传会剥头（整篇覆盖时剥头是正解）", () => {
    const uri = createTask({ title: "覆盖文档", project: PROJECT, body: "原始正文，长度足够不会被拒。" });
    const doc = "---\ntitle: 练习册答案\nnote: 手写文档\n---\n\n# 正文\n\n1. 答案 A\n";

    const report = updateTask(uri, { body: doc });

    expect(getTask(uri)!.body).toBe("# 正文\n\n1. 答案 A");
    expect(report.body_head_stripped?.keys).toEqual(["note", "title"]);
    expect(report.body_head_stripped?.head_text).toContain("练习册答案");
    expect(sepLines(rawOf(uri))).toBe(2);
  });

  it("getTask 暴露文件头原件（含非托管键）—— 读侧不必落盘求证", () => {
    const uri = createTask({ title: "暴露头", project: PROJECT, change_type: "fix", priority: "P2" });
    writeFileSync(
      fpOf(uri),
      rawOf(uri).replace("state: pending", "state: pending\nnote: '自定义'"),
      "utf-8",
    );

    const t = getTask(uri)!;
    expect(t.frontmatter["title"]).toBe("暴露头");
    expect(t.frontmatter["change_type"]).toBe("fix");
    expect(t.frontmatter["note"]).toBe("自定义");
  });
});
