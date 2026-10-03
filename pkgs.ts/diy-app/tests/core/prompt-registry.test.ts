// tests/core/prompt-registry.test.ts — 注册表单测（隔离 HOME，不碰 ~/.diy）
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listPrompts,
  getPrompt,
  savePrompt,
  restorePrompt,
  assembleSystem,
  assembleGlobals,
  SYSTEM_VARS,
  systemBudgetForContext,
  systemOverBudget,
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
  it("命名与角色：`_` = 锁定，role 由 _system.md 的 include 推导", () => {
    const all = listPrompts(home, PID);
    expect(all.map((e) => e.relpath)).toEqual([
      "_system.md",
      "identity.md",
      "diy.md",
      "project.md",
      "task.md",
      "rules.md",
      "skills.md",
      "_guard.md",
    ]);
    // 命名约定：`_` 前缀 = 锁定（双份：入口与保命契约）
    expect(getPrompt(home, PID, "_system.md").locked).toBe(true);
    expect(getPrompt(home, PID, "_system.md").lockTip.length).toBeGreaterThan(0);
    expect(getPrompt(home, PID, "_guard.md").locked).toBe(true);
    expect(getPrompt(home, PID, "rules.md").locked).toBe(false);
    // 角色：入口 / 节（其余都是被入口 include 的节）
    expect(getPrompt(home, PID, "_system.md").role).toBe("entry");
    expect(getPrompt(home, PID, "project.md").role).toBe("section");
    expect(all.every((e) => e.role === (e.relpath === "_system.md" ? "entry" : "section"))).toBe(true);
    expect(all.every((e) => e.status === "builtin")).toBe(true);
  });
  it("非法路径拒绝（含穿越）", () => {
    expect(() => getPrompt(home, PID, "../state")).toThrow();
    expect(() => getPrompt(home, PID, "nope.md")).toThrow();
  });
});

describe("systemOverBudget（真发与模版线共用的唯一预算判据）", () => {
  it("★ 两条链路都真的调它（源码护栏：真发曾内联 `bytes > budget`，两处口径会悄悄分叉）", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "main", "services", "local-agent.ts"), "utf-8");
    expect(src).toContain("systemOverBudget(");
    // 真发侧不得再自己算预算（systemBudgetForContext 只该在 prompt-registry 内部出现）
    expect(src).not.toContain("systemBudgetForContext(");
    expect(src).not.toMatch(/\.system\.bytes\s*>\s*sysBudget/);
  });

  it("★ 正好等于预算 → 放行（只有严格大于才拒发；边界错了会把刚好合格的提示词拒掉）", () => {
    const budget = systemBudgetForContext(256_000);
    expect(systemOverBudget(budget, 256_000)).toBeNull();
  });
  it("超 1 字节 → 拒发，并回传 used/budget 供错误文案使用", () => {
    const budget = systemBudgetForContext(256_000);
    expect(systemOverBudget(budget + 1, 256_000)).toEqual({ used: budget + 1, budget });
  });
  it("未知模型窗口 → 用硬上限兜底（不因缺参数而放行一切）", () => {
    expect(systemOverBudget(SYSTEM_BUDGET_CAP_BYTES + 1, undefined)).toEqual({
      used: SYSTEM_BUDGET_CAP_BYTES + 1,
      budget: SYSTEM_BUDGET_CAP_BYTES,
    });
    expect(systemOverBudget(1024, 0)).toBeNull();
  });
});

describe("save/restore", () => {
  it("保存后状态翻转为 overridden", () => {
    const after = savePrompt(home, PID, "identity.md", "定制身份\n");
    expect(after.status).toBe("overridden");
    expect(after.current).toBe("定制身份\n");
    expect(after.stale).toBe(false);
  });
  it("不可覆盖项保存抛错", () => {
    expect(() => savePrompt(home, PID, "_guard.md", "x")).toThrow();
  });
  it("恢复后回退内置（幂等）", () => {
    savePrompt(home, PID, "identity.md", "定制\n");
    const back = restorePrompt(home, PID, "identity.md");
    expect(back.status).toBe("builtin");
    expect(back.current).toContain("本地 coding agent");
    expect(() => restorePrompt(home, PID, "identity.md")).not.toThrow();
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
    const p = assembleSystem(home, PID, { drafts: { "identity.md": "草稿身份 {{diy.cli}}\n" } });
    expect(p.system).toContain("草稿身份 /repo/diy.sh");
    const q = assembleSystem(home, PID, {});
    expect(q.system).not.toContain("草稿身份");
  });
  it("超预算即报错（不自动截断）", () => {
    const big = "x".repeat(70 * 1024);
    const p = assembleSystem(home, PID, { drafts: { "identity.md": big } });
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
    const big = assembleSystem(home, PID, { drafts: { "identity.md": draft }, contextLimitTokens: 1_000_000 });
    const small = assembleSystem(home, PID, { drafts: { "identity.md": draft }, contextLimitTokens: 256_000 });
    expect(big.overBudget, "1M 窗口：填满到硬上限以内 → 不越框").toBeNull();
    expect(small.overBudget, "256k 窗口：同一份内容越框").not.toBeNull();
  });
  it("savePrompt 拒绝超限覆盖（避免写入后每一轮都被拒发）", () => {
    expect(() => savePrompt(home, PID, "identity.md", "z".repeat(70 * 1024))).toThrow(/超限/);
    // 未写入：仍是内置态
    expect(getPrompt(home, PID, "identity.md").status).toBe("builtin");
  });
  it("未知路径不再静默：装配直接抛错（引擎严格模式，没有「未知但放行」这条路）", () => {
    expect(() => assembleSystem(home, PID, { drafts: { "rules.md": "- {{diy.nope}}\n" } })).toThrow(
      /diy\.nope/,
    );
    expect(assembleSystem(home, PID, { taskUri: TASK }).system.length).toBeGreaterThan(0);
  });

  it("结构 trace 只在预览请求时产出（真发不分配）", () => {
    const plain = assembleSystem(home, PID, { taskUri: TASK });
    expect(plain.trace).toBeNull();
    const traced = assembleSystem(home, PID, { taskUri: TASK, trace: true });
    expect(traced.trace!.length).toBeGreaterThan(0);
    // 顶层是各节的 include：参数是 relpath，且带产出字节
    const args = traced.trace!.map((n) => n.arg);
    expect(args).toContain("./identity.md");
    expect(traced.trace!.every((n) => typeof n.bytes === "number")).toBe(true);
    // trace 不改变输出
    expect(traced.system).toBe(plain.system);
  });

  it("cwd 回退到应用目录时不注入启动目录的 AGENTS.md 链（shell 的偶然位置不是任务规范）", () => {
    // 无 taskUri + 项目路径不存在 → cwd = process.cwd()（= 应用/测试进程被启动的目录）。
    // 那时若去爬它的 AGENTS.md 链，注入的既不是任务的项目规范、也不是应用规范，
    // 且该目录恰是大仓库时（本仓库 pkgs.ts/diy-app/AGENTS.md 70 KB）会把 system 预算吃光
    // —— 连"保存一条模版覆盖"都会被体积校验拒绝（实测 2026-10-01 合并后 5 例红）。
    const noTask = assembleSystem(home, PID, {});
    const v = noTask.values as { cwd: { isAppDir: boolean }; chain: Array<{ path: string }> };
    expect(v.cwd.isAppDir).toBe(true);
    expect(v.chain).toEqual([]);

    // 应用级规范（$DIY_HOME/AGENTS.md）仍然注入：它不是"启动目录的偶然位置"
    writeFileSync(join(home, "AGENTS.md"), "应用级规范\n", "utf-8");
    const withApp = assembleSystem(home, PID, {});
    expect((withApp.values as { chain: Array<{ path: string }> }).chain.map((c) => c.path)).toEqual([
      join(home, "AGENTS.md"),
    ]);

    // 有任务时行为不变：cwd = 任务目录（项目路径不存在 → 回退任务目录），不是应用目录
    const withTask = assembleSystem(home, PID, { taskUri: TASK });
    expect((withTask.values as { cwd: { isAppDir: boolean } }).cwd.isAppDir).toBe(false);
  });

  it("链的包裹格式由 project.md 决定（可覆盖，不是硬编码）", () => {
    // 无链 → 本节只有说明文字，没有任何 <project_instructions>
    const p0 = assembleSystem(home, PID, { taskUri: TASK });
    expect(p0.system).not.toContain("project_instructions");

    // 造一条链：home/AGENTS.md（应用级，会被 unshift）
    writeFileSync(join(home, "AGENTS.md"), "应用级规范\n", "utf-8");
    const p1 = assembleSystem(home, PID, { taskUri: TASK });
    expect(p1.system).toContain('<project_instructions path="');
    expect(p1.system).toContain('scope="');
    expect(p1.system).toContain("应用级规范");

    // 覆盖 project.md → markup 变了（证明链的呈现确实模版化）
    savePrompt(
      home,
      PID,
      "project.md",
      [
        "---",
        "title: 项目规范",
        "desc: 测试覆盖",
        "version: 1",
        "---",
        '<template :for={{chain}} :as="f">',
        "<<{{.f.value.scope}}>>",
        "{{.f.value.content}}",
        "<</>>",
        "</template>",
        "",
      ].join("\n"),
    );
    const p2 = assembleSystem(home, PID, { taskUri: TASK });
    expect(p2.system).toContain(`<<${home}>>`);
    expect(p2.system).toContain("<</>>");
    expect(p2.system).not.toContain("<project_instructions");
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
    savePrompt(home, PID, "identity.md", "定制\n");
    expect(existsSync(meta)).toBe(true);
    const back = restorePrompt(home, PID, "identity.md");
    expect(back.status).toBe("builtin");
    expect(existsSync(meta)).toBe(false);
    expect(existsSync(join(home, "projects", PID, "template"))).toBe(false);
  });

  it("覆盖文件里的 frontmatter 不进请求；无 sidecar 的手工覆盖也算 stale", () => {
    const dir = join(home, "projects", PID, "template");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "identity.md"), "---\ntitle: 手写\n---\n正文身份\n", "utf-8");
    const e = getPrompt(home, PID, "identity.md");
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
    writeFileSync(join(dir, "gone-renamed.md"), "旧路径遗留\n", "utf-8");
    writeFileSync(join(dir, "identity.md"), "正文\n", "utf-8"); // 有效 relpath：不是孤儿
    const p = assembleSystem(home, PID, {});
    const hit = p.warnings.filter((w) => w.includes("不再生效"));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain("gone-renamed.md");
    expect(hit[0]).not.toContain("identity.md");
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

  it("变量契约与实际注入双向一致（加了变量忘写契约会被抓）", () => {
    writeFileSync(join(home, "AGENTS.md"), "根规则\n", "utf-8");
    const g = assembleGlobals(home, PID, { taskUri: TASK, skills: [{ name: "s", desc: "d" }] }) as unknown as Record<string, unknown>;

    const typeOf = (v: unknown): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
    const walk = (base: unknown, path: string): unknown => {
      let cur = base;
      for (const seg of path.split(".")) {
        if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[seg];
      }
      return cur;
    };
    // ① 契约 → 注入：每个声明路径都存在且类型相符
    for (const spec of SYSTEM_VARS) {
      expect(typeOf(walk(g, spec.path)), spec.path).toBe(spec.type);
    }
    // ② 注入 → 契约：注入里的每个叶子/集合路径都必须在契约里
    const declared = new Set(SYSTEM_VARS.map((v) => v.path));
    const missing: string[] = [];
    const visit = (node: unknown, prefix: string): void => {
      if (Array.isArray(node) || node === null || typeof node !== "object") {
        if (!declared.has(prefix)) missing.push(prefix);
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, prefix ? `${prefix}.${k}` : k);
      }
    };
    visit(g, "");
    expect(missing).toEqual([]);
    // 契约由 schema 派生（不再是手写清单）：抽查派生结果
    expect(SYSTEM_VARS.find((v) => v.path === "chain")?.type).toBe("array");
    expect(SYSTEM_VARS.find((v) => v.path === "cwd.isFallback")?.type).toBe("boolean");
    expect(SYSTEM_VARS.some((v) => v.path === "diy")).toBe(true); // 对象自身也是一条（{{diy}} 会报"是对象"）
  });
});

describe("投递节点（模版节 → Context Tree）", () => {
    it("★ 投递节点（模版节）由 assembleGlobals 渲染产出：identity/rules/guard 都在，且是模版渲染结果", () => {
      const g = assembleGlobals(home, PID, { taskUri: TASK, diyCli: "/repo/diy.sh" }) as unknown as Record<string, string>;
      // 身份节：身份行 + 人物（缺省人物来自内置 personas）——这就是真发 system 里那一段
      expect(g["identity"]).toContain("你是 diy 管控台的本地 coding agent");
      expect(g["identity"]).toContain("你现在的人物是");
      // 规范与保命契约：模版正文原样渲染（含标签）
      expect(g["rules"]).toContain("<rules>");
      expect(g["guard"]).toContain("<guard>");
      expect(g["guard"]).toContain("禁止执行会杀死宿主进程的命令");
      // 与模版线（assembleSystem）同源：同一份模版渲染，不是另写一段
      const tpl = assembleSystem(home, PID, { taskUri: TASK, diyCli: "/repo/diy.sh" }).system;
      for (const needle of ["<rules>", "<guard>", "你现在的人物是"]) {
        expect(tpl.includes(needle), `模版线缺 ${needle}`).toBe(true);
        expect(g["identity"].includes(needle) || g["rules"].includes(needle) || g["guard"].includes(needle)).toBe(true);
      }
    });

    it("项目级覆盖（projects/<id>/template/identity.md）也进投递节点", () => {
      mkdirSync(join(home, "projects", PID, "template"), { recursive: true });
      writeFileSync(
        join(home, "projects", PID, "template", "identity.md"),
        "你是本项目专属 agent，只回答一个字。\n",
        "utf-8",
      );
      const g = assembleGlobals(home, PID, { taskUri: TASK, diyCli: "/repo/diy.sh" }) as unknown as Record<string, string>;
      expect(g["identity"]).toContain("本项目专属 agent");
      expect(g["identity"]).not.toContain("diy 管控台的本地 coding agent");
    });

    it("草稿（未存盘的模版编辑）也进投递节点：预览与真发看到同一份", () => {
      const g = assembleGlobals(home, PID, {
        taskUri: TASK,
        diyCli: "/repo/diy.sh",
        drafts: { "rules.md": "<rules>\n- 只回答一个字\n</rules>\n" },
      }) as unknown as Record<string, string>;
      expect(g["rules"]).toContain("只回答一个字");
      expect(g["rules"]).not.toContain("用中文回答");
    });
});

describe("diy.md 入口辨析（防回退）", () => {
  it("必须讲清 diy / diy.sh / sha dev 的区别 —— 这是 agent 反复混淆的点", () => {
    const t = getPrompt(home, PID, "diy.md").builtin;
    // 四个关键概念，缺任一都会让 agent 重新分不清
    expect(t).toContain("入口辨析");
    expect(t).toContain("不启动应用"); // 它是客户端，不是"启动 app"
    expect(t).toContain("生产"); // 纯 diy = 生产版 + ~/.diy
    expect(t).toContain("worktree"); // worktree 里别用裸 diy
    expect(t).toContain("要起 GUI"); // 起 GUI 走 sha.sh dev，不是 CLI
    // 模版里不得出现裸反引号（会截断 TS 模版字符串）
    expect(t).not.toContain("\\`");
  });
});
