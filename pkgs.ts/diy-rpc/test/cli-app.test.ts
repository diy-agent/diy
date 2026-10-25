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

  it("叶子命令 usage 带上位置参数（[options] <arg>），无参时不追加", () => {
    const app = new CliApp({
      name: "diy",
      router: apiDef,
      transport: stubTransport,
    });
    const tree = (app as any).tree;
    const taskNode = tree.children.find((c: any) => c.name === "task");

    // 叶子 create：有 cliArg title → Usage 显示 <title>
    const createNode = taskNode.children.find((c: any) => c.name === "create");
    const out = captureLog(() => app.showNodeHelp(createNode));
    expect(out).toContain("Usage: diy task create [options] <title>");

    // 叶子 list：只有 cliOption，无位置参数 → 不追加
    const listNode = taskNode.children.find((c: any) => c.name === "list");
    const out2 = captureLog(() => app.showNodeHelp(listNode));
    expect(out2).toContain("Usage: diy task list [options]");
    expect(out2).not.toContain("[options] ");
  });
});

describe("CliApp.exitCodeOf", () => {
  const getApi = RpcSchema.router({
    facts: RpcSchema.group({
      desc: "事实库",
      children: {
        get: RpcSchema.unary({
          desc: "按 claim 取值",
          input: { claim: z.string().cliArg({ desc: "claim" }) },
          output: z.object({ resolved: z.array(z.unknown()), notes: z.array(z.string()) }),
        }),
      },
    }),
  });

  async function run(result: unknown, exitCodeOf?: (a: { rpcName: string; result: unknown }) => number | undefined) {
    const out: string[] = [];
    const err: string[] = [];
    const exitCodes: number[] = [];
    const transport = {
      invoke: vi.fn(async () => result),
      serverStream: vi.fn(),
      clientStream: vi.fn(),
      bidiStream: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ClientBinding;
    const app = new CliApp({
      name: "diy",
      router: getApi,
      transport,
      cliRootPath: "facts",
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      exit: ((c: number) => {
        exitCodes.push(c);
        throw new Error(`cli exit ${c}`);
      }) as (c: number) => void,
      exitCodeOf,
    });
    let thrown: unknown;
    try {
      await app.parse(["get", "bogus#x"]);
    } catch (e) {
      thrown = e;
    }
    return { out, err, exitCodes, thrown };
  }

  it("全空 ⇒ 打印后走 exit(1)，且不把退出哨兵当运行错误打到 stderr", async () => {
    const r = await run({ resolved: [], notes: ["claim 不存在"] }, ({ rpcName, result }) => {
      if (rpcName !== "facts.get") return undefined;
      return (result as { resolved: unknown[] }).resolved.length === 0 ? 1 : undefined;
    });
    expect(r.out.join("\n")).toContain('"resolved": []');
    expect(r.err).toEqual([]);
    expect(r.exitCodes).toEqual([1]);
    expect(r.thrown).toBeInstanceOf(Error);
  });

  it("非空 / 未提供判据 / 判据返回 0 ⇒ 退出码 0", async () => {
    expect((await run({ resolved: [{}] }, ({ rpcName, result }) =>
      rpcName === "facts.get" && (result as { resolved: unknown[] }).resolved.length === 0 ? 1 : undefined,
    )).exitCodes).toEqual([]);
    expect((await run({ resolved: [] })).exitCodes).toEqual([]);
    expect((await run({ resolved: [] }, () => 0)).exitCodes).toEqual([]);
  });
});
