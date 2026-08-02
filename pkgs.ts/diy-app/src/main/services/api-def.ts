/**
 * api-def.ts — Main 进程 RPC 纯定义（meta，无 call）
 *
 * 只含 zod schema，供 server 端绑定 handler（api-impl.ts）和
 * 客户端 createTypedClient 推导强类型。
 * 命名与 py 侧 `diy <域> <命令>` 对齐。
 */

import { RpcSchema } from "@diy/rpc";
import { z } from "zod";

// 任务状态枚举（内联，保持 api-def 无 Node 依赖、浏览器安全）
const TaskStateSchema = z.enum([
  "pending",
  "active",
  "done",
  "cancelled",
  "blocked",
  "shelved",
  "new",
  "open",
  "closed",
]);

const StatusDataUri = z.object({ status: z.string(), data: z.object({ uri: z.string() }) });
const StatusDataPath = z.object({ status: z.string(), data: z.object({ path: z.string() }) });
const StatusOk = z.object({ status: z.string() });

const MessageParam = z.object({ role: z.string(), content: z.string() });

export const apiDef = {
  task: {
    create: RpcSchema.unary({
      input: {
        title: z.string().min(1, "标题不能为空").max(200).cliArg({ desc: "任务标题" }),
        subject: z.string().cliArg({ desc: "所属 subject 路径" }),
        parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
        detail: z.string().optional().cliOption({ desc: "任务详情" }),
        body: z.string().optional().cliOption({ desc: "任务正文" }),
      },
      output: StatusDataUri,
    }),
    list: RpcSchema.unary({
      input: {
        subject: z.string().optional().cliOption({ short: "s", desc: "按 subject 筛选" }),
      },
      output: z.object({ status: z.string(), data: z.object({ tasks: z.any() }) }),
    }),
    show: RpcSchema.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
      },
      output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
    }),
    edit: RpcSchema.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
        title: z.string().optional().cliOption({ short: "t", desc: "新标题" }),
        state: TaskStateSchema.optional().cliOption({ desc: "新状态" }),
        detail: z.string().optional().cliOption({ desc: "新详情" }),
      },
      output: StatusDataUri,
    }),
    delete: RpcSchema.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
      },
      output: StatusDataUri,
    }),
    star: RpcSchema.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
      },
      output: z.object({ status: z.string(), data: z.object({ uri: z.string(), starred: z.boolean() }) }),
    }),
    unstar: RpcSchema.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
      },
      output: z.object({ status: z.string(), data: z.object({ uri: z.string(), starred: z.boolean() }) }),
    }),
  },

  subject: {
    add: RpcSchema.unary({
      input: {
        path: z.string().min(1, "路径不能为空").cliArg({ desc: "subject 路径" }),
        label: z.string().optional().cliOption({ short: "l", desc: "显示名称" }),
      },
      output: StatusDataPath,
    }),
    list: RpcSchema.unary({
      input: {},
      output: z.object({ status: z.string(), data: z.object({ subjects: z.any() }) }),
    }),
    remove: RpcSchema.unary({
      input: {
        path: z.string().cliArg({ desc: "subject 路径" }),
      },
      output: StatusDataPath,
    }),
  },

  ui: {
    tree: RpcSchema.unary({
      input: {
        all: z.boolean().optional().cliOption({ short: "a", desc: "显示全部任务" }),
      },
      output: z.object({ status: z.string(), data: z.string() }),
    }),
    status: RpcSchema.unary({
      input: {},
      output: z.object({ status: z.string(), data: z.object({ pid: z.number(), uptime: z.number(), memory: z.number() }) }),
    }),
  },

  doctor: RpcSchema.unary({
    input: {},
    output: z.object({
      status: z.string(),
      data: z.object({
        pid: z.number(),
        home: z.string(),
        state_exists: z.boolean(),
        issues: z.array(z.string()),
        healthy: z.boolean(),
      }),
    }),
  }),

  loadTaskTree: RpcSchema.unary({
    input: { allTasks: z.boolean().optional() },
    output: z.any(),
  }),

  getTask: RpcSchema.unary({
    input: { uri: z.string() },
    output: z.any(),
  }),

  agent: {
    chat: RpcSchema.unary({
      input: {
        model: z.string().cliArg({ desc: "模型名称" }),
        messages: z.array(MessageParam).cliOption({ desc: "消息数组 JSON" }),
      },
      output: z.object({ role: z.string(), content: z.string() }),
    }),
    chatStream: RpcSchema.serverStream({
      input: {
        model: z.string(),
        messages: z.array(MessageParam),
      },
      output: z.any(),
    }),
    listModels: RpcSchema.unary({
      input: {},
      output: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
    status: RpcSchema.unary({
      input: {
        agentId: z.string().cliArg({ desc: "Agent ID" }),
      },
      output: z.object({ agentId: z.string(), state: z.string(), model: z.string() }),
    }),
  },

  llmProxy: {
    status: RpcSchema.unary({
      input: {},
      output: z.object({ running: z.boolean(), port: z.number() }),
    }),
    start: RpcSchema.unary({
      input: {},
      output: StatusOk,
    }),
    stop: RpcSchema.unary({
      input: {},
      output: StatusOk,
    }),
  },

  log: {
    read: RpcSchema.unary({
      input: {
        limit: z.number().optional().cliOption({ desc: "返回条目数" }),
      },
      output: z.array(z.any()),
    }),
  },

  ref: {
    sync: RpcSchema.unary({
      input: {
        all: z.boolean().optional().cliOption({ short: "a", desc: "sync 所有 scope" }),
        scope: z.string().optional().cliOption({ desc: "指定 scope 名称" }),
        concurrency: z.number().default(4).optional().cliOption({ desc: "并发克隆数" }),
      },
      output: z.object({ status: z.string(), data: z.any() }),
    }),
    list: RpcSchema.unary({
      input: {
        all: z.boolean().optional().cliOption({ short: "a", desc: "显示所有 scope" }),
      },
      output: z.object({ status: z.string(), data: z.any() }),
    }),
    status: RpcSchema.unary({
      input: {},
      output: z.object({
        status: z.string(),
        data: z.object({
          total: z.number(),
          missing: z.number(),
          paths: z.any(),
        }),
      }),
    }),
    add: RpcSchema.unary({
      input: {
        url: z.string().cliArg({ desc: "Git 仓库 URL" }),
      },
      output: z.object({ status: z.string(), data: z.object({ added: z.any() }) }),
    }),
    remove: RpcSchema.unary({
      input: {
        name: z.string().cliArg({ desc: "仓库标识（diy.yaml 中注册的 URL 或 host/owner/repo）" }),
      },
      output: z.object({ status: z.string(), data: z.object({ removed: z.any() }) }).or(z.object({ status: z.string(), msg: z.string() })),
    }),
  },
} as const;

export type ApiDef = typeof apiDef;
