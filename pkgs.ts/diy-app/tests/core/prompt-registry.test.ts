// tests/core/prompt-registry.test.ts — 注册表单测（隔离 HOME，不碰 ~/.diy）
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listPrompts,
  getPrompt,
  savePrompt,
  restorePrompt,
  renderTemplate,
  previewRequest,
  type AssembleVars,
} from "../../src/main/services/prompt-registry";

let home: string;
const PID = "99";
const TASK = `projects/${PID}/tasks/1`;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "diy-prompt-lab-"));
  // CLI 入口是环境事实，固定它才能断言渲染结果
  process.env["DIY_CLI"] = "/repo/diy.sh";
  mkdirSync(join(home, "projects", PID, "tasks", "1"), { recursive: true });
  writeFileSync(join(home, "projects", PID, "meta.yaml"), `id: '${PID}'\npath: /tmp/nonexist\n`, "utf-8");
});

const vars = (): AssembleVars => ({
  diy_cli: "/repo/diy.sh",
  diy_home: home,
  project_path: "/tmp/nonexist",
  task_uri: TASK,
  task_title: "标题",
  task_state: "pending",
  task_body: "正文",
  task_dir: join(home, TASK),
  cwd: join(home, TASK),
  cwd_note: "",
  project_instructions: "",
  skills: "",
});

describe("list/get", () => {
  it("全部内置态，六节 + 一锁定节", () => {
    const all = listPrompts(home, PID);
    expect(all.map((e) => e.relpath)).toEqual([
      "000-identity.md",
      "100-diy.md",
      "200-project.md",
      "300-task.md",
      "400-rules.md",
      "500-skills.md",
      "_guard.md",
    ]);
    expect(all.every((e) => e.status === "builtin")).toBe(true);
    expect(getPrompt(home, PID, "000-identity.md").overridable).toBe(true);
  });
  it("不可覆盖项自带 tip", () => {
    const g = getPrompt(home, PID, "_guard.md");
    expect(g.overridable).toBe(false);
    expect(g.tip.length).toBeGreaterThan(0);
  });
  it("非法路径拒绝（含穿越）", () => {
    expect(() => getPrompt(home, PID, "../state")).toThrow();
    expect(() => getPrompt(home, PID, "nope.md")).toThrow();
  });
});

describe("save/restore", () => {
  it("保存后状态翻转为 overridden", () => {
    const after = savePrompt(home, PID, "000-identity.md", "定制身份\n");
    expect(after.status).toBe("overridden");
    expect(after.current).toBe("定制身份\n");
    expect(after.stale).toBe(false);
  });
  it("不可覆盖项保存抛错", () => {
    expect(() => savePrompt(home, PID, "_guard.md", "x")).toThrow();
  });
  it("恢复后回退内置（幂等）", () => {
    savePrompt(home, PID, "000-identity.md", "定制\n");
    const back = restorePrompt(home, PID, "000-identity.md");
    expect(back.status).toBe("builtin");
    expect(back.current).toContain("本地 coding agent");
    expect(() => restorePrompt(home, PID, "000-identity.md")).not.toThrow();
  });
});

describe("renderTemplate", () => {
  it("白名单变量替换，未知保留 + 上报", () => {
    const r = renderTemplate("a={{cwd}} b={{nope}}", vars());
    expect(r.text).toBe(`a=${join(home, TASK)} b={{nope}}`);
    expect(r.unknown).toEqual(["nope"]);
  });
});

describe("previewRequest 装配", () => {
  it("按序拼接：identity 裸文本，其余节带标签", () => {
    const p = previewRequest(home, PID, { taskUri: TASK });
    expect(p.system.startsWith("你是 diy 管控台的本地 coding agent")).toBe(true);
    expect(p.system).toContain("<diy>");
    expect(p.system).toContain("<project_context>");
    expect(p.system).toContain("<rules>");
    expect(p.system).toContain("<guard>");
    // 空节（skills 未接入）不进请求
    expect(p.system).not.toContain("<skills>");
    // 节序：diy 在 rules 之前，guard 垫底
    expect(p.system.indexOf("<diy>")).toBeLessThan(p.system.indexOf("<rules>"));
    expect(p.system.indexOf("<guard>")).toBeGreaterThan(p.system.indexOf("<rules>"));
  });
  it("任务字段进 <task>，正文进 prompt；任务本体不被当作项目规范重复注入", () => {
    writeFileSync(
      join(home, TASK, "AGENTS.md"),
      `---\ntitle: 绑定验证任务\nstate: pending\n---\n任务正文内容\n`,
      "utf-8",
    );
    const p = previewRequest(home, PID, { taskUri: TASK });
    expect(p.system).toContain("绑定验证任务");
    expect(p.system).toContain("任务正文内容");
    // 陷阱回归：tasks/<tid>/AGENTS.md 不得出现在 project_instructions 里
    expect(p.system).not.toContain(`<project_instructions path="${join(home, TASK, "AGENTS.md")}"`);
  });
  it("drafts 未存盘草稿替存盘值（所见即所得）", () => {
    const p = previewRequest(home, PID, { drafts: { "000-identity.md": "草稿身份 {{diy_cli}}\n" } });
    expect(p.system).toContain("草稿身份 /repo/diy.sh");
    const q = previewRequest(home, PID, {});
    expect(q.system).not.toContain("草稿身份");
  });
  it("超预算即报错（不自动截断）", () => {
    const big = "x".repeat(70 * 1024);
    const p = previewRequest(home, PID, { drafts: { "000-identity.md": big } });
    expect(p.overBudget).not.toBeNull();
    expect(p.overBudget!.used).toBeGreaterThan(p.overBudget!.budget);
  });
  it("未知变量上报", () => {
    const p = previewRequest(home, PID, { drafts: { "400-rules.md": "- {{nope}}\n" } });
    expect(p.unknownVars).toEqual(["nope"]);
  });
});

// 清理：mkdtemp 目录不自动回收，避免 /tmp 堆积
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});
