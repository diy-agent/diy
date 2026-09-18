// tests/core/prompt-registry.test.ts — 注册表单测（隔离 HOME，不碰 ~/.diy）
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listPrompts,
  getPrompt,
  savePrompt,
  restorePrompt,
  renderTemplate,
  previewRequest,
} from "../../src/main/services/prompt-registry";

let home: string;
const PID = "99";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "diy-prompt-lab-"));
  // 最小项目注册：projects/99/meta.yaml（projectDir 扫描用）
  mkdirSync(join(home, "projects", PID), { recursive: true });
  writeFileSync(join(home, "projects", PID, "meta.yaml"), `id: '${PID}'\npath: /tmp/nonexist\n`, "utf-8");
});

describe("list/get", () => {
  it("全部内置态，无覆盖", () => {
    const all = listPrompts(home, PID);
    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(all.every((e) => e.status === "builtin")).toBe(true);
    const sys = getPrompt(home, PID, "system.md");
    expect(sys.overridable).toBe(true);
    expect(sys.title).toBe("系统身份");
  });
  it("不可覆盖项自带 tip", () => {
    const g = getPrompt(home, PID, "guard/self-kill.md");
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
    const after = savePrompt(home, PID, "system.md", "定制身份\n");
    expect(after.status).toBe("overridden");
    expect(after.current).toBe("定制身份\n");
    expect(after.stale).toBe(false);
  });
  it("不可覆盖项保存抛错", () => {
    expect(() => savePrompt(home, PID, "guard/self-kill.md", "x")).toThrow();
  });
  it("恢复后回退内置（幂等）", () => {
    savePrompt(home, PID, "system.md", "定制\n");
    const back = restorePrompt(home, PID, "system.md");
    expect(back.status).toBe("builtin");
    expect(back.current).toContain("本地代码助手");
    expect(() => restorePrompt(home, PID, "system.md")).not.toThrow();
  });
});

describe("renderTemplate", () => {
  const vars = {
    cwd: "/tmp/p",
    project_path: "/tmp/p",
    project_label: "99",
    task_uri: "projects/99/tasks/1",
    model: "mimo-v2.5",
    maxSteps: 60,
    maxOutputTokens: 4000,
    skills: "",
  };
  it("白名单变量替换，未知保留 + 上报", () => {
    const r = renderTemplate("a={{cwd}} b={{nope}}", vars);
    expect(r.text).toBe("a=/tmp/p b={{nope}}");
    expect(r.unknown).toEqual(["nope"]);
  });
});

describe("previewRequest drafts", () => {
  it("drafts 未存盘草稿替存盘值（所见即所得）", () => {
    const p = previewRequest(home, PID, { model: "hy3", drafts: { "system.md": "草稿身份 {{model}}\n" } });
    expect(p.system).toContain("草稿身份 hy3");
    // 存盘未动：不带 drafts 则回内置
    const q = previewRequest(home, PID, { model: "hy3" });
    expect(q.system).not.toContain("草稿身份");
  });
});

describe("previewRequest", () => {
  it("dry-run 组装：覆盖生效，参数可调", () => {
    savePrompt(home, PID, "system.md", "定制身份 {{model}}\n");
    const p = previewRequest(home, PID, { model: "hy3", maxSteps: 10 });
    expect(p.system).toContain("定制身份 hy3");
    expect(p.system).toContain("## 项目上下文");
    expect(p.settings.maxSteps).toBe(10);
    expect(p.tools.map((t) => t.name)).toEqual(["bash", "read"]);
  });
});
