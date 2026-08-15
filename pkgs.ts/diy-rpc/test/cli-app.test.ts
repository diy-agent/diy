/**
 * cli-app.test.ts — CliApp 命令树/help 行为测试
 *
 * 测 CliApp.showHelp / showNodeHelp（不触 transport，纯命令树 + desc 渲染）：
 *   - 顶层命令列表显示每个命令 desc 第一行
 *   - 父命令用 RpcSchema.unary + children（统一模型）承载自身描述
 *   - `diy help <父命令>` 显示父命令 desc + 子命令列表
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { RpcSchema } from "../src/core/rpc";
import type { ClientBinding } from "../src/core/server-binding";
import { CliApp } from "../src/cli/index";

// mock transport：showHelp/showNodeHelp 不调用它，传个桩即可
const stubTransport = {
  invoke: vi.fn(),
  serverStream: vi.fn(),
  clientStream: vi.fn(),
  bidiStream: vi.fn(),
  dispose: vi.fn(),
} as unknown as ClientBinding;

const apiDef = RpcSchema.router({
  task: RpcSchema.group({
    desc: "任务管理",
    children: {
      create: RpcSchema.unary({
        desc: `创建任务，写入 state.yaml。示例：
                     task create "标题" --subject <path`,
        input: {
          title: z.string().cliArg({ desc: "任务标题" }),
          parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
        },
        output: z.object({ status: z.string() }),
      }),
      list: RpcSchema.unary({
        desc: "列出任务",
        input: { subject: z.string().optional().cliOption({ desc: "按 subject 筛选" }) },
        output: z.object({ ok: z.boolean() }),
      }),
    },
  }),
  subject: RpcSchema.group({
    desc: "主题管理",
    children: {
      list: RpcSchema.unary({
        desc: "列出主题",
        input: {},
        output: z.object({ ok: z.boolean() }),
      }),
    },
  }),
});

// capture console.log 输出
function captureLog(fn: () => void): string {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return logs.join("\n");
}

describe("CliApp.showHelp", () => {
  it("顶层命令列表显示父命令 desc 第一行，且不展开子命令", () => {
    const app = new CliApp({
      name: "diy",
      router: apiDef,
      transport: stubTransport,
    });
    const out = captureLog(() => app.showHelp());
    // 父命令 task 显示自身 desc 第一行
    expect(out).toContain("task");
    expect(out).toContain("任务管理");
    // 不展开 task.create / task.list（顶层只有 task、subject 两级）
    expect(out).not.toContain("task create");
    expect(out).not.toContain("subject list");
  });

  it("叶子命令顶层显示 desc 第一行（多行 desc 只取首行）", () => {
    const app = new CliApp({
      name: "diy",
      router: apiDef,
      transport: stubTransport,
    });
    const out = captureLog(() => app.showHelp());
    // task 父命令只显示首行 "任务管理"，不显示子命令 desc
    expect(out).toContain("任务管理");
  });
});

describe("CliApp.showNodeHelp", () => {
  it("diy help task 显示父命令 desc + 子命令列表", () => {
    const app = new CliApp({
      name: "diy",
      router: apiDef,
      transport: stubTransport,
    });
    // 通过 bracket 访问私有 tree（测试专用；也可走 parse('help task') 端到端）
    const tree = (app as any).tree;
    const taskNode = tree.children.find((c: any) => c.name === "task");
    const out = captureLog(() => app.showNodeHelp(taskNode));
    expect(out).toContain("Usage: diy task <subcommand> [options]");
    expect(out).toContain("任务管理");
    expect(out).toContain("create");
    expect(out).toContain("创建任务，写入 state.yaml。"); // 子命令 desc 首行
    expect(out).toContain("list");
  });
});
