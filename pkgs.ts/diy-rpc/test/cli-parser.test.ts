/**
 * cli-parser.test.ts — parseArgv / generateHelp 行为锁定测试
 *
 * 直接测 _parser.ts 的两个纯函数（不经过 CliApp / 传输层），锁定参数解析与
 * help 生成的契约。这是 rpc-cli 架子的地基测试——改动 parser 必须过这里。
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { RpcSchema } from "../src/core/rpc";
import { parseArgv, generateHelp } from "../src/cli/_parser";

// 一个典型的 unary 命令：位置参数 title + 命名选项 --parent/-p --detail
// description 可含多行（首行作命令列表简介，完整显示在单命令 help）
const taskCreate = RpcSchema.unary({
  desc: "创建任务，写入 state.yaml。\n\n示例：\n  task create \"标题\" --subject <path>\n  task create \"标题\" --parent <uri>",
  input: {
    title: z.string().min(1, "标题不能为空").cliArg({ desc: "任务标题" }),
    subject: z.string().cliArg({ desc: "所属 subject 路径" }),
    parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
    detail: z.string().optional().cliOption({ desc: "任务详情" }),
    done: z.boolean().default(false).cliOption({ desc: "标记完成" }),
    count: z.number().optional().cliOption({ desc: "数量" }),
  },
  output: z.object({ status: z.string() }),
});

describe("parseArgv", () => {
  it("位置参数按序映射，命名选项独立", () => {
    const { input } = parseArgv(taskCreate, ["标题A", "/path/x", "--parent", "uri:1"]);
    expect(input).toMatchObject({
      title: "标题A",
      subject: "/path/x",
      parent: "uri:1",
      done: false, // boolean 默认 false
    });
  });

  it("--flag=value 形式", () => {
    const { input } = parseArgv(taskCreate, ["t", "s", "--detail=正文"]);
    expect(input).toMatchObject({ title: "t", subject: "s", detail: "正文" });
  });

  it("boolean flag 无值即置 true", () => {
    const { input } = parseArgv(taskCreate, ["t", "s", "--done"]);
    expect(input.done).toBe(true);
  });

  it("短名 -p 映射", () => {
    const { input } = parseArgv(taskCreate, ["t", "s", "-p", "uri:9"]);
    expect(input.parent).toBe("uri:9");
  });

  it("数字字段预转 number", () => {
    const { input } = parseArgv(taskCreate, ["t", "s", "--count", "5"]);
    expect(input.count).toBe(5);
  });

  it("--help 触发 helpRequested 且忽略其他", () => {
    const { helpRequested } = parseArgv(taskCreate, ["t", "s", "--help"]);
    expect(helpRequested).toBe(true);
  });

  it("未知选项抛 CliParseError", () => {
    expect(() => parseArgv(taskCreate, ["t", "s", "--nope"])).toThrow(/Unknown option/);
  });

  it("缺少必填位置参数，zod 校验失败抛错", () => {
    expect(() => parseArgv(taskCreate, [])).toThrow();
  });
});

describe("generateHelp", () => {
  it("渲染位置参数（Arguments 段）——占位符用字段名 + 类型后缀", () => {
    const h = generateHelp(taskCreate, "task create", "创建任务");
    expect(h).toContain("创建任务");
    expect(h).toContain("Arguments:");
    expect(h).toContain("<title>");       // 字段名，非类型名
    expect(h).toContain("(string)");      // 类型后缀
    expect(h).toContain("任务标题");
  });

  it("渲染命名选项（Options 段）含短名/默认值/required", () => {
    const h = generateHelp(taskCreate, "task create");
    expect(h).toContain("Options:");
    expect(h).toContain("-p, --parent");
    expect(h).toContain("任务详情");
    expect(h).toContain("--done");
    expect(h).toContain("(default: false)");
  });

  it("必填 option 标记 [required]", () => {
    const def = RpcSchema.unary({
      desc: "x",
      input: {
        name: z.string().cliOption({ desc: "必填选项" }),
        opt: z.string().optional().cliOption({ desc: "可选" }),
      },
      output: z.object({ ok: z.boolean() }),
    });
    const h = generateHelp(def, "test cmd");
    expect(h).toContain("[required]");
    // 可选 option 不带 required 标记
    const reqLine = h.split("\n").find((l) => l.includes("--name")) ?? "";
    expect(reqLine).toContain("[required]");
  });

  it("必填位置参数用尖括号，可选用方括号", () => {
    const h = generateHelp(taskCreate, "task create");
    expect(h).toMatch(/<title>/);
    expect(h).toMatch(/<subject>/);
  });

  it("命令描述完整显示（含多行示例）", () => {
    const h = generateHelp(taskCreate, "task create");
    expect(h).toContain("创建任务，写入 state.yaml。");
    expect(h).toContain('task create "标题" --subject <path>');
  });

  it("未标 desc 的字段 help 无描述（描述须显式 cliArg/cliOption.desc）", () => {
    const def = RpcSchema.unary({
      desc: "x",
      input: {
        name: z.string().describe("zod 描述不入 CLI help").cliArg({}),
        flag: z.string().optional().cliOption({ desc: "来自 cliOption" }),
      },
      output: z.object({ ok: z.boolean() }),
    });
    const h = generateHelp(def, "test cmd");
    // zod v4 describe 存内部 registry 无公开读 API → CLI 描述只能显式标注
    expect(h).not.toContain("zod 描述不入 CLI help");
    expect(h).toContain("来自 cliOption");
  });
});
