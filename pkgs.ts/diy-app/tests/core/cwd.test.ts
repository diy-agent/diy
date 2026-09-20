// tests/core/cwd.test.ts — 工作目录解析（唯一实现，工具 cwd 与提示词「工作目录」必须同源）
//
// 隔离 HOME/DIY_HOME 由 tests/setup.ts 注入，这里只在其下造 fixture。
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCwd } from "../../src/main/core/cwd";

const HOME = () => process.env["DIY_HOME"]!;
const PID = "97";
const TASK = `projects/${PID}/tasks/1`;

/** 写项目元数据（path 指向的项目目录是否存在由用例决定） */
function setProject(relpath: string): string {
  const dir = join(HOME(), "projects", PID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.yaml"), `id: '${PID}'\npath: ${relpath}\n`, "utf-8");
  return relpath;
}

beforeEach(() => {
  mkdirSync(join(HOME(), "projects", PID, "tasks", "1"), { recursive: true });
});

describe("resolveCwd", () => {
  it("项目目录存在 → 用它且无提示", () => {
    const repo = join(HOME(), "proj-exists");
    mkdirSync(repo, { recursive: true });
    setProject(repo);
    const r = resolveCwd(HOME(), TASK);
    expect(r.cwd).toBe(repo);
    expect(r.note).toBe("");
    expect(r.isFallback).toBe(false);
  });

  it("`~/` 展开为 $HOME（测试里 HOME 已被隔离）", () => {
    const rel = "home-sub";
    mkdirSync(join(HOME(), rel), { recursive: true });
    setProject(`~/${rel}`);
    const r = resolveCwd(HOME(), TASK);
    expect(r.cwd).toBe(join(HOME(), rel));
    expect(r.note).toBe("");
    expect(r.isFallback).toBe(false);
  });

  it("项目目录不存在 → 退回任务目录 + 提示", () => {
    setProject(join(HOME(), "not-there"));
    const r = resolveCwd(HOME(), TASK);
    expect(r.cwd).toBe(join(HOME(), TASK));
    expect(r.note).toBe("项目目录不存在，工具实际在任务目录下执行");
    expect(r.isFallback).toBe(true);
    expect(r.isTaskDir).toBe(true);
  });

  it("两级都不存在 → 进程 cwd + 提示（模型据此知道路径基准不一样）", () => {
    setProject(join(HOME(), "not-there"));
    const r = resolveCwd(HOME(), "projects/98/tasks/9"); // 无对应目录
    expect(r.cwd).toBe(process.cwd());
    expect(r.note).toBe("项目目录与任务目录都不存在，工具实际在应用目录下执行");
    expect(r.isFallback).toBe(true);
    expect(r.isAppDir).toBe(true);
  });
});
