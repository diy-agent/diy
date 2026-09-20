// tests/core/prompt-registry.test.ts — 注册表单测（隔离 HOME，不碰 ~/.diy）
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listPrompts,
  getPrompt,
  savePrompt,
  restorePrompt,
  assembleSystem,
  systemBudgetForContext,
  SYSTEM_BUDGET_CAP_BYTES,
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

describe("list/get", () => {
  it("全部内置态：装配入口 system.md + 七个节 + 链片段", () => {
    const all = listPrompts(home, PID);
    expect(all.map((e) => e.relpath)).toEqual([
      "system.md",
      "000-identity.md",
      "100-diy.md",
      "200-project.md",
      "300-task.md",
      "400-rules.md",
      "500-skills.md",
      "_chain.md",
      "_guard.md",
    ]);
    // 装配入口锁定（改它就改结构）
    expect(getPrompt(home, PID, "system.md").overridable).toBe(false);
    expect(getPrompt(home, PID, "system.md").tip.length).toBeGreaterThan(0);
    // 结构与标签也在模版里（不再藏代码）：tag 由 frontmatter 声明，_chain.md 是片段
    expect(getPrompt(home, PID, "200-project.md").tag).toBe("project_context");
    expect(getPrompt(home, PID, "000-identity.md").tag).toBe("");
    expect(getPrompt(home, PID, "_chain.md").fragment).toBe(true);
    expect(getPrompt(home, PID, "100-diy.md").fragment).toBe(false);
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

describe("assembleSystem 装配", () => {
  it("按序拼接：identity 裸文本，其余节带标签", () => {
    const p = assembleSystem(home, PID, { taskUri: TASK });
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
    const p = assembleSystem(home, PID, { taskUri: TASK });
    expect(p.system).toContain("绑定验证任务");
    expect(p.system).toContain("任务正文内容");
    // 陷阱回归：tasks/<tid>/AGENTS.md 不得出现在 project_instructions 里
    expect(p.system).not.toContain(`<project_instructions path="${join(home, TASK, "AGENTS.md")}"`);
  });
  it("drafts 未存盘草稿替存盘值（所见即所得）", () => {
    const p = assembleSystem(home, PID, { drafts: { "000-identity.md": "草稿身份 {{diy.cli}}\n" } });
    expect(p.system).toContain("草稿身份 /repo/diy.sh");
    const q = assembleSystem(home, PID, {});
    expect(q.system).not.toContain("草稿身份");
  });
  it("超预算即报错（不自动截断）", () => {
    const big = "x".repeat(70 * 1024);
    const p = assembleSystem(home, PID, { drafts: { "000-identity.md": big } });
    expect(p.overBudget).not.toBeNull();
    expect(p.overBudget!.used).toBeGreaterThan(p.overBudget!.budget);
  });
  it("预算随模型上下文窗口变：小窗口拿更小预算，大窗口封顶硬上限", () => {
    // 256k tokens × 4B × 5% ≈ 51KB < 64KB → 真实生效
    expect(systemBudgetForContext(256_000)).toBeLessThan(SYSTEM_BUDGET_CAP_BYTES);
    expect(systemBudgetForContext(256_000)).toBeGreaterThan(16 * 1024);
    // 1M tokens → 超上限 → 封顶
    expect(systemBudgetForContext(1_000_000)).toBe(SYSTEM_BUDGET_CAP_BYTES);
    // 未知/非法 → 默认（保持旧行为）
    expect(systemBudgetForContext(undefined)).toBe(SYSTEM_BUDGET_CAP_BYTES);
    expect(systemBudgetForContext(0)).toBe(SYSTEM_BUDGET_CAP_BYTES);
    // 小窗口不落地到 0（有下限）
    expect(systemBudgetForContext(1_000)).toBe(16 * 1024);
    // 同一份草稿：小窗口模型更早被判越框（预算按窗口算 → 不再是一个定值）
    const base = assembleSystem(home, PID, { contextLimitTokens: 1_000_000 });
    const room = SYSTEM_BUDGET_CAP_BYTES - Buffer.byteLength(base.system, "utf-8") - 1024;
    const draft = "y".repeat(room);
    const big = assembleSystem(home, PID, { drafts: { "000-identity.md": draft }, contextLimitTokens: 1_000_000 });
    const small = assembleSystem(home, PID, { drafts: { "000-identity.md": draft }, contextLimitTokens: 256_000 });
    expect(big.overBudget, "1M 窗口：填满到硬上限以内 → 不越框").toBeNull();
    expect(small.overBudget, "256k 窗口：同一份内容越框").not.toBeNull();
  });
  it("savePrompt 拒绝超限覆盖（避免写入后每一轮都被拒发）", () => {
    expect(() => savePrompt(home, PID, "000-identity.md", "z".repeat(70 * 1024))).toThrow(/超限/);
    // 未写入：仍是内置态
    expect(getPrompt(home, PID, "000-identity.md").status).toBe("builtin");
  });
  it("未知路径不再静默：装配直接抛错（引擎严格模式，替代旧的 unknownVars 警告）", () => {
    expect(() => assembleSystem(home, PID, { drafts: { "400-rules.md": "- {{diy.nope}}\n" } })).toThrow(
      /diy\.nope/,
    );
    // 正常装配不抛错，unknownVars 恒为空（没有"未知但放行"这条路）
    expect(assembleSystem(home, PID, { taskUri: TASK }).unknownVars).toEqual([]);
  });

  it("片段模版不进节拼接；链的包裹格式由 _chain.md 决定（可覆盖）", () => {
    // 无链 → 片段不出现任何痕迹
    const p0 = assembleSystem(home, PID, { taskUri: TASK });
    expect(p0.system).not.toContain("_chain");
    expect(p0.system).not.toContain("project_instructions");

    // 造一条链：home/AGENTS.md（应用级，会被 unshift）
    writeFileSync(join(home, "AGENTS.md"), "应用级规范\n", "utf-8");
    const p1 = assembleSystem(home, PID, { taskUri: TASK });
    expect(p1.system).toContain('<project_instructions path="');
    expect(p1.system).toContain("scope=\"");
    expect(p1.system).toContain("应用级规范");

    // 覆盖 _chain.md → markup 变了（证明这段结构确实模版化，而不是硬编码）
    // DSL 写法：三个局部变量都带点；且必须都被引用（引擎会做参数双向校验）
    savePrompt(home, PID, "_chain.md", "<<{{.scope}}>>\n{{.path}}\n{{.content}}\n<</{{.scope}}>>");
    const p2 = assembleSystem(home, PID, { taskUri: TASK });
    expect(p2.system).toContain(`<<${home}>>`);
    expect(p2.system).toContain("<</");
    expect(p2.system).not.toContain("<project_instructions");
    expect(p2.unknownVars).toEqual([]);
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

// ── 回归：code review 实测暴露的问题（每条都对应一次真实踩坑） ──
describe("回归：评审修复项", () => {
  it("assertRelpath 用 Object.hasOwn：原型链键不得命中（曾把 400 变成 500）", () => {
    expect(() => getPrompt(home, PID, "toString")).toThrow(/非法模版路径/);
    expect(() => getPrompt(home, PID, "constructor")).toThrow(/非法模版路径/);
    expect(() => savePrompt(home, PID, "toString", "x")).toThrow(/非法模版路径/);
  });

  it("restore 后不留空 sidecar / 空目录", () => {
    const meta = join(home, "projects", PID, "template", ".meta.yaml");
    savePrompt(home, PID, "000-identity.md", "定制\n");
    expect(existsSync(meta)).toBe(true);
    const back = restorePrompt(home, PID, "000-identity.md");
    expect(back.status).toBe("builtin");
    expect(existsSync(meta)).toBe(false);
    expect(existsSync(join(home, "projects", PID, "template"))).toBe(false);
  });

  it("覆盖文件里的 frontmatter 不进请求；无 sidecar 的手工覆盖也算 stale", () => {
    const dir = join(home, "projects", PID, "template");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "000-identity.md"), "---\ntitle: 手写\n---\n正文身份\n", "utf-8");
    const e = getPrompt(home, PID, "000-identity.md");
    expect(e.current).toBe("正文身份\n");
    expect(e.stale).toBe(true); // 来源不可知 → 提示可能过期，不再永真 false
    const p = assembleSystem(home, PID, {});
    expect(p.system).not.toContain("title: 手写");
  });

  it("缺 DIY_CLI：上报 warnings，且文案不冒充真实入口", () => {
    const old = process.env["DIY_CLI"];
    delete process.env["DIY_CLI"];
    try {
      const p = assembleSystem(home, PID, {});
      expect(p.warnings).toHaveLength(1);
      expect(p.warnings[0]).toContain("未注入 DIY_CLI");
      expect(p.system).toContain("未注入 DIY_CLI");
    } finally {
      process.env["DIY_CLI"] = old;
    }
  });

  it("孤儿覆盖文件（relpath 已不在清单）上报告警，不静默失效", () => {
    const dir = join(home, "projects", PID, "template");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skills.md"), "旧路径遗留\n", "utf-8");
    writeFileSync(join(dir, "000-identity.md"), "正文\n", "utf-8"); // 有效 relpath：不是孤儿
    const p = assembleSystem(home, PID, {});
    const hit = p.warnings.filter((w) => w.includes("不再生效"));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain("skills.md");
    expect(hit[0]).not.toContain("000-identity.md");
  });

  it("AGENTS.md 链逐层向上到 $HOME 为止（含 ~/AGENTS.md 这类全局规则），不越过 $HOME", () => {
    // 布局（“家目录”一层要有，再往上一层不能有）：
    //   outer/AGENTS.md              ← $HOME 之上：不该进
    //   outer/home/AGENTS.md         ← $HOME 层（同时也是应用级）：该进
    //   outer/home/projects/AGENTS.md ← 中间层：该进
    //   outer/home/projects/<pid>/AGENTS.md ← 项目层：该进
    const outer = mkdtempSync(join(tmpdir(), "diy-chain-"));
    const homeDir = join(outer, "home");
    const projDir = join(homeDir, "projects", PID);
    mkdirSync(join(projDir, "tasks", "1"), { recursive: true });
    writeFileSync(join(outer, "AGENTS.md"), "$HOME 之上的规范（不该进）\n", "utf-8");
    writeFileSync(join(homeDir, "AGENTS.md"), "家目录级规范\n", "utf-8");
    writeFileSync(join(homeDir, "projects", "AGENTS.md"), "中间层规范\n", "utf-8");
    writeFileSync(join(projDir, "AGENTS.md"), "项目级规范\n", "utf-8");

    // HOME/DIY_HOME 都指向 homeDir，复现真实布局（项目在 ~ 下）
    const oldHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
    try {
      const p = assembleSystem(homeDir, PID, { taskUri: TASK });
      expect(p.system).toContain("项目级规范");
      expect(p.system).toContain("中间层规范");
      expect(p.system).toContain("家目录级规范");
      expect(p.system).not.toContain("$HOME 之上的规范");
      // 外层在前、最深处在后
      expect(p.system.indexOf("家目录级规范")).toBeLessThan(p.system.indexOf("中间层规范"));
      expect(p.system.indexOf("中间层规范")).toBeLessThan(p.system.indexOf("项目级规范"));
    } finally {
      process.env["HOME"] = oldHome;
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
