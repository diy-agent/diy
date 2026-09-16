// tests/core/state.test.ts
// 🎯 核心意图测试：state.yaml 读写、AGENTS.md 解析
//    所有测试数据在 /tmp/diy-desktop-test-xxx/ 下，不碰生产 ~/.diy/

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import {
  loadState,
  saveState,
  parseTaskFile,
  getTask,
  taskExists,
  taskFilePath,
} from "../../src/main/core/state";

// ═══════════════════════════════════════
// state.yaml 读写
// ═══════════════════════════════════════

describe("state.yaml 读写", () => {
  it("文件不存在时返回默认 profiles 和空 subjects", () => {
    const state = loadState();

    const quick = state.profiles.get("quick");
    expect(quick?.area).toBe("main");
    expect(quick?.merge).toBe("direct");
    expect(quick?.approval).toBeNull();

    const standard = state.profiles.get("standard");
    expect(standard?.area).toBe("branch");
    expect(standard?.merge).toBe("pr");

    expect(state.subjects.size).toBe(0);
  });

  it("保存后 reload 数据一致", () => {
    const subjects = new Map<string, { label: string }>([
      ["~/work", { label: "工作项目" }],
      ["~/home", { label: "个人项目" }],
    ]);
    saveState({ subjects });

    const loaded = loadState();
    expect(loaded.subjects.get("~/work")?.label).toBe("工作项目");
    expect(loaded.subjects.get("~/home")?.label).toBe("个人项目");
  });

  it("第二次调用会完全覆盖 subjects", () => {
    saveState({ subjects: new Map([["~/x", { label: "X" }]]) });
    saveState({ subjects: new Map([["~/y", { label: "Y" }]]) });

    const loaded = loadState();
    // x 被覆盖了（saveState 是全量替换）
    expect(loaded.subjects.get("~/x")).toBeUndefined();
    expect(loaded.subjects.get("~/y")?.label).toBe("Y");
  });
});

// ═══════════════════════════════════════
// AGENTS.md 解析
// ═══════════════════════════════════════

describe("parseTaskFile", () => {
  it("解析标准的 AGENTS.md（frontmatter + body）", () => {
    const raw = `---
title: 测试任务
state: active
---
这是正文内容`;
    const meta = parseTaskFile(raw);
    expect(meta).not.toBeNull();
    expect(meta?.title).toBe("测试任务");
    expect(meta?.state).toBe("active");
    expect(meta?.body).toBe("这是正文内容");
  });

  it("不解析 project / subject —— project 由 URI 路径推导，不落盘", () => {
    // 历史数据里的 project 字段是冗余副本（可能与实际路径不同步），故忽略。
    // 读取属于哪个 project 走 getTask（由 URI 推导），见 state.test.ts 的 getTask 用例。
    const raw = `---
title: 旧任务
project: work
subject: legacy
---
正文`;
    const meta = parseTaskFile(raw);
    expect((meta as Record<string, unknown>)["project"]).toBeUndefined();
  });

  it("无 frontmatter 时返回 null", () => {
    expect(parseTaskFile("纯文本内容")).toBeNull();
  });

  it("空的 frontmatter 但含 body 可解析", () => {
    const raw = `---
---
只有 body`;
    const meta = parseTaskFile(raw);
    expect(meta).not.toBeNull();
    expect(meta?.body).toBe("只有 body");
  });

  it("完整 frontmatter 但无 body 可解析", () => {
    const raw = `---
title: 无正文任务
state: pending
---`;
    const meta = parseTaskFile(raw);
    expect(meta?.title).toBe("无正文任务");
    expect(meta?.body).toBe("");
  });

  it("缺失 closing --- 时返回 null", () => {
    const raw = `---
title: 坏文件`;
    expect(parseTaskFile(raw)).toBeNull();
  });
});

// ═══════════════════════════════════════
// getTask / taskExists
// ═══════════════════════════════════════

describe("getTask & taskExists", () => {
  const uri = "projects/1/tasks/2";

  beforeAll(() => {
    const dir = join(diyHome(), uri);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "---\ntitle: 获取测试\nstate: pending\n---\n正文内容");
  });

  it("不存在的任务返回 null", () => {
    expect(getTask("projects/9/tasks/9")).toBeNull();
    expect(taskExists("projects/9/tasks/9")).toBe(false);
  });

  it("存在的任务返回完整数据", () => {
    const task = getTask(uri);
    expect(task).not.toBeNull();
    expect(task!.uri).toBe(uri);
    expect(task!.title).toBe("获取测试");
    expect(task!.state).toBe("pending");
    expect(task!.body).toBe("正文内容");
    expect(task!.project).toBe("1"); // 由 URI 路径推导
  });

  it("frontmatter 写了 project 也不认 —— 以 URI 路径为准（路径是唯一真相源）", () => {
    const uri2 = "projects/1/tasks/77";
    const dir2 = join(diyHome(), uri2);
    mkdirSync(dir2, { recursive: true });
    // 故意写一个与实际路径不一致的 project（冗余副本可能不同步）
    writeFileSync(join(dir2, "AGENTS.md"), "---\ntitle: 不一致\nstate: pending\nproject: '999'\n---\n");

    expect(getTask(uri2)!.project).toBe("1");
  });

  it("taskExists 返回 true", () => {
    expect(taskExists(uri)).toBe(true);
  });

  it("taskFilePath 返回正确路径", () => {
    const fp = taskFilePath(uri);
    expect(fp).toBe(join(diyHome(), uri, "AGENTS.md"));
  });
});

// ═══════════════════════════════════════
// diyHome 环境隔离验证
// ═══════════════════════════════════════

describe("测试环境隔离", () => {
  it("DIY_HOME 包含临时目录标识，不指向真实 ~/.diy/", () => {
    const home = diyHome();
    // setup.ts 设了 DIY_HOME = mkdtempSync('diy-desktop-test-')
    expect(home).toContain("diy-desktop-test-");
    // 确保不指向真实 HOME 下的 .diy
    const realHome = require("node:os").homedir();
    expect(home).not.toBe(realHome + "/.diy");
  });
});
