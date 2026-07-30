import { z } from "zod";
import { RpcImpl, router } from "@diy/rpc";
import * as task from "../core/task";
import * as subject from "../core/subject";
import * as state from "../core/state";
import * as taskTree from "../core/task-tree";
import * as health from "./health";
import { refList, checkRefPaths } from "../core/ref";
import { syncRefs } from "./ref-sync";
import { addSource, removeSource } from "./ref-config";

let _agentClient: any = null;
async function getAgentClient() {
  if (!_agentClient) {
    const { AcpAgentClient } = await import("./acp-agent");
    _agentClient = new AcpAgentClient();
  }
  return _agentClient;
}
let _llmProxyInstance: any = null;
async function getLlmProxy() {
  if (!_llmProxyInstance) {
    const { LlmProxy } = await import("./llm-proxy");
    _llmProxyInstance = new LlmProxy();
  }
  return _llmProxyInstance;
}

const StatusDataUri = z.object({ status: z.string(), data: z.object({ uri: z.string() }) });
const StatusDataPath = z.object({ status: z.string(), data: z.object({ path: z.string() }) });
const StatusOk = z.object({ status: z.string() });

export const api = router({
  task: router({
    create: RpcImpl.unary({
      input: {
        title: z.string().min(1, "标题不能为空").max(200).cliArg({ desc: "任务标题" }),
        subject: z.string().cliArg({ desc: "所属 subject 路径" }),
        parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
        detail: z.string().optional().cliOption({ desc: "任务详情" }),
        body: z.string().optional().cliOption({ desc: "任务正文" }),
      },
      output: StatusDataUri,
      call: async ({ input }) => {
        return { status: "ok", data: { uri: task.createTask(input as any) } };
      },
    }),

    list: RpcImpl.unary({
      input: {
        subject: z.string().optional().cliOption({ short: "s", desc: "按 subject 筛选" }),
      },
      output: z.object({ status: z.string(), data: z.object({ tasks: z.any() }) }),
      call: async ({ input }) => {
        return { status: "ok", data: { tasks: task.listTasks(input.subject) } };
      },
    }),

    show: RpcImpl.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
      },
      output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
      call: async ({ input }) => {
        const t = state.getTask(input.uri);
        if (!t) return { status: "error", msg: `任务 ${input.uri} 不存在` };
        return { status: "ok", data: t };
      },
    }),

    edit: RpcImpl.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
        title: z.string().optional().cliOption({ short: "t", desc: "新标题" }),
        state: task.TaskStateSchema.optional().cliOption({ desc: "新状态" }),
        detail: z.string().optional().cliOption({ desc: "新详情" }),
      },
      output: StatusDataUri,
      call: async ({ input }) => {
        const { uri, ...changes } = input;
        const filtered: Record<string, string> = {};
        for (const [k, v] of Object.entries(changes)) {
          if (v !== undefined) filtered[k] = v as string;
        }
        task.updateTask(uri, filtered);
        return { status: "ok", data: { uri } };
      },
    }),

    delete: RpcImpl.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
      },
      output: StatusDataUri,
      call: async ({ input }) => {
        task.deleteTask(input.uri);
        return { status: "ok", data: { uri: input.uri } };
      },
    }),

    star: RpcImpl.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
      },
      output: z.object({ status: z.string(), data: z.object({ uri: z.string(), starred: z.boolean() }) }),
      call: async ({ input }) => {
        state.starTask(input.uri);
        return { status: "ok", data: { uri: input.uri, starred: true } };
      },
    }),

    unstar: RpcImpl.unary({
      input: {
        uri: z.string().cliArg({ desc: "任务 URI" }),
      },
      output: z.object({ status: z.string(), data: z.object({ uri: z.string(), starred: z.boolean() }) }),
      call: async ({ input }) => {
        state.unstarTask(input.uri);
        return { status: "ok", data: { uri: input.uri, starred: false } };
      },
    }),
  }),

  subject: router({
    add: RpcImpl.unary({
      input: {
        path: z.string().min(1, "路径不能为空").cliArg({ desc: "subject 路径" }),
        label: z.string().optional().cliOption({ short: "l", desc: "显示名称" }),
      },
      output: StatusDataPath,
      call: async ({ input }) => {
        subject.addSubject(input.path, input.label);
        return { status: "ok", data: { path: input.path } };
      },
    }),

    list: RpcImpl.unary({
      input: {},
      output: z.object({ status: z.string(), data: z.object({ subjects: z.any() }) }),
      call: async () => {
        return { status: "ok", data: { subjects: subject.listSubjects() } };
      },
    }),

    remove: RpcImpl.unary({
      input: {
        path: z.string().cliArg({ desc: "subject 路径" }),
      },
      output: StatusDataPath,
      call: async ({ input }) => {
        subject.removeSubject(input.path);
        return { status: "ok", data: { path: input.path } };
      },
    }),
  }),

  ui: router({
    tree: RpcImpl.unary({
      input: {
        all: z.boolean().optional().cliOption({ short: "a", desc: "显示全部任务" }),
      },
      output: z.object({ status: z.string(), data: z.string() }),
      call: async ({ input }) => {
        return { status: "ok", data: taskTree.renderTreeText(taskTree.loadTaskTree(input.all)) };
      },
    }),

    status: RpcImpl.unary({
      input: {},
      output: z.object({ status: z.string(), data: z.object({ pid: z.number(), uptime: z.number(), memory: z.number() }) }),
      call: () => ({
        status: "ok",
        data: { pid: process.pid, uptime: process.uptime(), memory: process.memoryUsage().heapUsed },
      }),
    }),
  }),

  doctor: RpcImpl.unary({
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
    call: async () => {
      const issues = health.runHealthCheck();
      const home = state.diyHome();
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      return {
        status: "ok",
        data: {
          pid: process.pid,
          home,
          state_exists: existsSync(join(home, "state.yaml")),
          issues: issues.map((i) => i.message),
          healthy: issues.length === 0,
        },
      };
    },
  }),

  loadTaskTree: RpcImpl.unary({
    input: { allTasks: z.boolean().optional() },
    output: z.any(),
    call: async ({ input }) => {
      return taskTree.loadTaskTree(input.allTasks);
    },
  }),

  getTask: RpcImpl.unary({
    input: { uri: z.string() },
    output: z.any(),
    call: async ({ input }) => {
      return state.getTask(input.uri);
    },
  }),

  agent: router({
    chat: RpcImpl.unary({
      input: {
        model: z.string().cliArg({ desc: "模型名称" }),
        messages: z.array(z.object({ role: z.string(), content: z.string() })).cliOption({ desc: "消息数组 JSON" }),
      },
      output: z.object({ role: z.string(), content: z.string() }),
      call: async ({ input }) => {
        const client = await getAgentClient();
        const result = await client.chat(input.model, input.messages);
        return { role: result.role, content: result.content };
      },
    }),

    chatStream: RpcImpl.serverStream({
      input: {
        model: z.string(),
        messages: z.array(z.object({ role: z.string(), content: z.string() })),
      },
      output: z.any(),
      call: async function* ({ input }) {
        const client = await getAgentClient();
        for await (const delta of client.streamChat(input.model, input.messages)) {
          yield delta;
        }
      },
    }),

    listModels: RpcImpl.unary({
      input: {},
      output: z.array(z.object({ id: z.string(), name: z.string() })),
      call: () => [
        { id: "llama3.2", name: "Llama 3.2" },
        { id: "hermes", name: "Hermes Agent" },
      ],
    }),

    status: RpcImpl.unary({
      input: {
        agentId: z.string().cliArg({ desc: "Agent ID" }),
      },
      output: z.object({ agentId: z.string(), state: z.string(), model: z.string() }),
      call: async ({ input }) => {
        const client = await getAgentClient();
        const s = await client.getAgentStatus(input.agentId);
        return { agentId: s.agentId, state: s.state, model: s.model };
      },
    }),
  }),

  llmProxy: router({
    status: RpcImpl.unary({
      input: {},
      output: z.object({ running: z.boolean(), port: z.number() }),
      call: async () => {
        const proxy = await getLlmProxy();
        return { running: proxy.isRunning, port: 8000 };
      },
    }),

    start: RpcImpl.unary({
      input: {},
      output: StatusOk,
      call: async () => {
        const proxy = await getLlmProxy();
        proxy.start();
        return { status: "ok" };
      },
    }),

    stop: RpcImpl.unary({
      input: {},
      output: StatusOk,
      call: async () => {
        const proxy = await getLlmProxy();
        proxy.stop();
        return { status: "ok" };
      },
    }),
  }),

  log: router({
    read: RpcImpl.unary({
      input: {
        limit: z.number().optional().cliOption({ desc: "返回条目数" }),
      },
      output: z.array(z.any()),
      call: async ({ input }) => {
        const { existsSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const logPath = join(state.diyHome(), "app.log");
        if (!existsSync(logPath)) return [];
        const raw = readFileSync(logPath, "utf-8");
        return raw
          .split("\n")
          .filter(Boolean)
          .reverse()
          .slice(0, input.limit ?? 200)
          .map((line: string) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              return { raw: line };
            }
          });
      },
    }),
  }),

  ref: router({
    sync: RpcImpl.unary({
      input: {
        all: z.boolean().optional().cliOption({ short: "a", desc: "sync 所有 scope" }),
        scope: z.string().optional().cliOption({ desc: "指定 scope 名称" }),
        concurrency: z.number().default(4).optional().cliOption({ desc: "并发克隆数" }),
      },
      output: z.object({ status: z.string(), data: z.any() }),
      call: async ({ input }) => {
        const result = await syncRefs({
          all: input.all,
          scope: input.scope,
          concurrency: input.concurrency,
        });
        return { status: "ok", data: result };
      },
    }),

    list: RpcImpl.unary({
      input: {
        all: z.boolean().optional().cliOption({ short: "a", desc: "显示所有 scope" }),
      },
      output: z.object({ status: z.string(), data: z.any() }),
      call: async ({ input }) => {
        return { status: "ok", data: refList(input.all) };
      },
    }),

    status: RpcImpl.unary({
      input: {},
      output: z.object({
        status: z.string(),
        data: z.object({
          total: z.number(),
          missing: z.number(),
          paths: z.any(),
        }),
      }),
      call: async () => {
        const paths = checkRefPaths();
        const missing = paths.filter((p) => !p.exists);
        return {
          status: "ok",
          data: { total: paths.length, missing: missing.length, paths },
        };
      },
    }),

    add: RpcImpl.unary({
      input: {
        url: z.string().cliArg({ desc: "Git 仓库 URL" }),
      },
      output: z.object({ status: z.string(), data: z.object({ added: z.any() }) }),
      call: async ({ input }) => {
        return { status: "ok", data: { added: addSource(input.url) } };
      },
    }),

    remove: RpcImpl.unary({
      input: {
        name: z.string().cliArg({ desc: "仓库标识（diy.yaml 中注册的 URL 或 host/owner/repo）" }),
      },
      output: z.object({ status: z.string(), data: z.object({ removed: z.any() }) }).or(z.object({ status: z.string(), msg: z.string() })),
      call: async ({ input }) => {
        const removed = removeSource(input.name);
        if (!removed) return { status: "error", msg: `未找到 source: ${input.name}` };
        return { status: "ok", data: { removed } };
      },
    }),
  }),
});

export type Api = typeof api;
