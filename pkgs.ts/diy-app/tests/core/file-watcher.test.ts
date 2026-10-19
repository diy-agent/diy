// tests/core/file-watcher.test.ts — 文件监听的事件分类（##361）
//
// 真实故障：手工 `rm -rf <任务目录>`（或 `task delete` 的 rmSync）之后，nav 上那一行
// 还挂着（点进去永远「加载中…」）。根因是分类判据只认「文件级事件且路径以 AGENTS.md
// 结尾」—— 目录整棵被删时 chokidar 报的是 `unlinkDir`（子文件的 unlink 不保证逐条
// emit），一条都不认 → 不发 task-change → 任务树不重载。
//
// 这里锁死三件事：
//   ① `unlinkDir` 落在 projects/ 下 → task-change（删任务目录 / 删项目目录）
//   ② `unlink` / `add` 的判据与 `change` **对齐**（/tasks/ 下任意路径，不只 AGENTS.md）
//   ③ 非任务路径（projects/<pid>/template/*.md、logs/ 等）一律不触发 —— 别把「保存一次
//      提示词模版」也变成任务树重载（那是曾经修过的噪音）
import { describe, expect, it } from "vitest";
import { classifyWatchEvent } from "../../src/main/services/file-watcher";

const HOME = "/tmp/diy-home";
const TASK = `${HOME}/projects/p1/tasks/t1`;

describe("classifyWatchEvent —— 目录整棵被删也必须重载树", () => {
  it("unlinkDir 任务目录 → task-change（##361 的根因）", () => {
    expect(classifyWatchEvent("unlinkDir", TASK)).toBe("task-change");
  });

  it("unlinkDir 项目目录 → task-change（项目没了，树也变）", () => {
    expect(classifyWatchEvent("unlinkDir", `${HOME}/projects/p1`)).toBe("task-change");
  });

  it("unlink /tasks/ 下任意路径 → task-change（判据与 change 对齐，不再只认 AGENTS.md）", () => {
    expect(classifyWatchEvent("unlink", `${TASK}/AGENTS.md`)).toBe("task-change");
    expect(classifyWatchEvent("unlink", `${TASK}/body.md`)).toBe("task-change");
    expect(classifyWatchEvent("unlink", TASK)).toBe("task-change");
  });

  it("add / addDir 任务路径 → task-change（新建任务目录 / 新建任务文档）", () => {
    expect(classifyWatchEvent("addDir", TASK)).toBe("task-change");
    expect(classifyWatchEvent("add", `${TASK}/AGENTS.md`)).toBe("task-change");
    expect(classifyWatchEvent("add", `${TASK}/body.md`)).toBe("task-change");
  });

  it("change：任务文档 / 项目 meta 触发，其余不触发（保持既有语义）", () => {
    expect(classifyWatchEvent("change", `${TASK}/AGENTS.md`)).toBe("task-change");
    expect(classifyWatchEvent("change", `${HOME}/projects/p1/meta.yaml`)).toBe("task-change");
    expect(classifyWatchEvent("change", `${HOME}/projects/p1/template/t.md`)).toBeNull();
  });

  it("非任务**文件**（任何事件）一律空 — 不许把模版/日志的保存写成树重载", () => {
    expect(classifyWatchEvent("change", `${HOME}/projects/p1/template/t.md`)).toBeNull();
    expect(classifyWatchEvent("add", `${HOME}/projects/p1/template/t.md`)).toBeNull();
    expect(classifyWatchEvent("unlink", `${HOME}/projects/p1/template/t.md`)).toBeNull();
    expect(classifyWatchEvent("change", `${HOME}/log/x.log`)).toBeNull();
  });

  it("projects/ 下**目录**增删一律认（与 addDir 对称；目录级操作低频，代价可接受）", () => {
    // 之所以不给 unlinkDir 单独写更窄的判据：它必须与 addDir 对称（同一个「目录出现/消失」
    // 的两种方向），否则又是「一松一紧」。要防的噪音是**文件级** change（保存模版），
    // 那一条仍在下面这条被挡住。
    expect(classifyWatchEvent("unlinkDir", `${HOME}/projects/p1/template`)).toBe("task-change");
  });

  it("state.yaml / agents/ 的判据不串台", () => {
    expect(classifyWatchEvent("change", `${HOME}/state.yaml`)).toBe("state-change");
    expect(classifyWatchEvent("change", `${HOME}/agents/a1/config.yaml`)).toBe("agent-change");
    expect(classifyWatchEvent("add", `${HOME}/state.yaml`)).toBeNull(); // 保持既有语义：只有 change
    expect(classifyWatchEvent("unlinkDir", `${HOME}/agents`)).toBeNull();
  });
});
