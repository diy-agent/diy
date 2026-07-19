// tests/cli.intent.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 CLI 意图测试 — 契约 / 人类可读的输出格式验证
//
// 规则：
//   1. 输出完整的 YAML/文本，一字不差
//   2. * 只用于真正随机值（URI、PID、临时路径）
//   3. 意图测试 = 人类和 AI 沟通的契约
//   4. 测试顺序即意图顺序 — 先建后删
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll } from "vitest";
import { ShellTest } from "./shell-test";

let sh: ShellTest;
let HOME: string;

beforeAll(() => {
  HOME = process.env["DIY_HOME"]!;
  sh = new ShellTest({ diyHome: HOME });
});

// ═══════════════════════════════════════════════════════════════
// subject — 先测，此时 state.yaml 尚未创建
// ═══════════════════════════════════════════════════════════════

describe("subject", () => {
  it("list — 空列表", () => {
    sh.assertSession(`
      $ diy2 subject list
      status: ok
      data:
        subjects: []
    `);
  });

  it("add — 注册新 subject", () => {
    sh.assertSession(`
      $ diy2 subject add ${HOME}/work --label 工作
      status: ok
      data:
        path: ${HOME}/work
    `);
  });

  it("add — 重复注册（覆盖 label）", () => {
    sh.assertSession(`
      $ diy2 subject add ${HOME}/work --label 工程
      status: ok
      data:
        path: ${HOME}/work
    `);
  });

  it("list — 列出已注册 subject", () => {
    sh.assertSession(`
      $ diy2 subject list
      status: ok
      data:
        subjects:
          - path: ${HOME}/work
            info:
              label: 工程
    `);
  });

  it("remove — 移除 subject", () => {
    sh.assertSession(`
      $ diy2 subject remove ${HOME}/work
      status: ok
      data:
        path: ${HOME}/work
    `);
  });

  it("remove — 移除不存在的 subject（幂等）", () => {
    sh.assertSession(`
      $ diy2 subject remove ${HOME}/work
      status: ok
      data:
        path: ${HOME}/work
    `);
  });

  it("list — 移除后为空", () => {
    sh.assertSession(`
      $ diy2 subject list
      status: ok
      data:
        subjects: []
    `);
  });

  it("add — 空路径报错", () => {
    sh.assertSession(`
      $! diy2 subject add ''
      *路径不能为空*
    `);
  });
});

// ═══════════════════════════════════════════════════════════════
// task
// ═══════════════════════════════════════════════════════════════

describe("task", () => {
  beforeAll(() => {
    sh.diy2("subject", "add", `${HOME}/tasks`, "--label", "任务");
  });

  it("list — 空列表", () => {
    sh.assertSession(`
      $ diy2 task list
      status: ok
      data:
        tasks: []
    `);
  });

  it("create — 创建任务", () => {
    sh.assertSession(`
      $ diy2 task create 研究一下 ${HOME}/tasks
      status: ok
      data:
        uri: *
    `);
  });

  it("create — 创建带详情和父任务的子任务", () => {
    const list = sh.diy2("task", "list");
    const parentUri = list.stdout.match(/-\s+(\S+)/)![1]!;

    sh.assertSession(`
      $ diy2 task create 子任务 ${HOME}/tasks --parent ${parentUri} --detail 这是详情
      status: ok
      data:
        uri: *
    `);
  });

  it("list — 包含两个任务", () => {
    sh.assertSession(`
      $ diy2 task list
      status: ok
      data:
        tasks:
          - *
          - *
    `);
  });

  it("show — 查看任务详情", () => {
    const list = sh.diy2("task", "list");
    const uri = list.stdout.match(/-\s+(\S+)/)![1]!;

    sh.assertSession(`
      $ diy2 task show ${uri}
      status: ok
      data:
        uri: ${uri}
        title: 研究一下
        state: pending
        subject: ${HOME}/tasks
        created: '*'
        updated: '*'
        body: ''
    `);
  });

  it("edit — 修改标题", () => {
    const list = sh.diy2("task", "list");
    const uri = list.stdout.match(/-\s+(\S+)/)![1]!;

    sh.assertSession(`
      $ diy2 task edit ${uri} --title 已修改
      status: ok
      data:
        uri: ${uri}
    `);

    sh.assertSession(`
      $ diy2 task show ${uri}
      status: ok
      data:
        uri: ${uri}
        title: 已修改
        state: pending
        subject: ${HOME}/tasks
        created: '*'
        updated: '*'
        body: ''
    `);
  });

  it("star — 关注任务", () => {
    const list = sh.diy2("task", "list");
    const uri = list.stdout.match(/-\s+(\S+)/)![1]!;

    sh.assertSession(`
      $ diy2 task star ${uri}
      status: ok
      data:
        uri: ${uri}
        starred: true
    `);
  });

  it("unstar — 取消关注", () => {
    const list = sh.diy2("task", "list");
    const uri = list.stdout.match(/-\s+(\S+)/)![1]!;

    sh.assertSession(`
      $ diy2 task unstar ${uri}
      status: ok
      data:
        uri: ${uri}
        starred: false
    `);
  });

  it("delete — 删除任务", () => {
    const list = sh.diy2("task", "list");
    const uri = list.stdout.match(/-\s+(\S+)/)![1]!;

    sh.assertSession(`
      $ diy2 task delete ${uri}
      status: ok
      data:
        uri: ${uri}
    `);
  });

  it("delete — 删除不存在的任务（幂等）", () => {
    sh.assertSession(`
      $ diy2 task delete local/nonexistent
      status: ok
      data:
        uri: local/nonexistent
    `);
  });

  it("create — 空标题报错", () => {
    sh.assertSession(`
      $! diy2 task create '' ${HOME}/tasks
      *标题不能为空*
    `);
  });

  it("show — 不存在的任务报错", () => {
    sh.assertSession(`
      $ diy2 task show local/nonexistent
      status: error
      msg: 任务 local/nonexistent 不存在
    `);
  });
});

// ═══════════════════════════════════════════════════════════════
// ui
// ═══════════════════════════════════════════════════════════════

describe("ui", () => {
  it("status — 返回进程信息", () => {
    sh.assertSession(`
      $ diy2 ui status
      status: ok
      data:
        pid: *
        uptime: *
        memory: *
    `);
  });

  it("tree — 返回文本树", () => {
    sh.assertSession(`
      $ diy2 ui tree
      status: ok
      data: *
    `);
  });

  it("navigate — 切换页面（无 GUI 时 meta.pushedToGui=false）", () => {
    sh.assertSession(`
      $ diy2 ui navigate task
      status: ok
      data:
        page: task
      meta:
        pushedToGui: false
    `);
  });

  it("focus — 选中任务（无 GUI 时 meta.pushedToGui=false）", () => {
    sh.assertSession(`
      $ diy2 ui focus local/abc
      status: ok
      data:
        uri: local/abc
      meta:
        pushedToGui: false
    `);
  });

  it("toast — 弹通知（无 GUI 时 meta.pushedToGui=false）", () => {
    sh.assertSession(`
      $ diy2 ui toast 测试消息 --level info
      status: ok
      data:
        message: 测试消息
        level: info
      meta:
        pushedToGui: false
    `);
  });
});

// ═══════════════════════════════════════════════════════════════
// doctor — 最后测，此时 state.yaml 已存在
// ═══════════════════════════════════════════════════════════════

describe("doctor", () => {
  it("正常状态 — state.yaml 已存在", () => {
    sh.assertSession(`
      $ diy2 doctor
      status: ok
      data:
        pid: *
        home: ${HOME}
        state_exists: true
        issues: []
        healthy: true
    `);
  });
});
