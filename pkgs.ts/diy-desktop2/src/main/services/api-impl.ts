/**
 * api-impl.ts — Main 进程 RPC handler 绑定（handle 分离）
 *
 * 从 api-def.ts 导入纯 meta，通过 RpcServer.on() 逐个绑定实现。
 * 业务逻辑在这里，schema 定义在 api-def.ts。
 */

import { RpcServer, type Transport } from "@diy/rpc";
import * as task from "../core/task";
import * as subject from "../core/subject";
import * as state from "../core/state";
import * as taskTree from "../core/task-tree";
import * as health from "./health";
import { refList, checkRefPaths } from "../core/ref";
import { syncRefs } from "./ref-sync";
import { addSource, removeSource } from "./ref-config";
import { apiDef } from "./api-def";

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

/** 绑定 Main 侧所有 handler 到给定 transport 上的 RpcServer */
export function bindApi(transport: Transport): RpcServer {
  const server = new RpcServer({ router: apiDef, transport });

  // ── task ──
  server.on(apiDef.task.create, async ({ input }) => {
    return { status: "ok", data: { uri: task.createTask(input as any) } };
  });
  server.on(apiDef.task.list, async ({ input }) => {
    return { status: "ok", data: { tasks: task.listTasks(input.subject) } };
  });
  server.on(apiDef.task.show, async ({ input }) => {
    const t = state.getTask(input.uri);
    if (!t) return { status: "error", msg: `任务 ${input.uri} 不存在` };
    return { status: "ok", data: t };
  });
  server.on(apiDef.task.edit, async ({ input }) => {
    const { uri, ...changes } = input;
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v !== undefined) filtered[k] = v as string;
    }
    task.updateTask(uri, filtered);
    return { status: "ok", data: { uri } };
  });
  server.on(apiDef.task.delete, async ({ input }) => {
    task.deleteTask(input.uri);
    return { status: "ok", data: { uri: input.uri } };
  });
  server.on(apiDef.task.star, async ({ input }) => {
    state.starTask(input.uri);
    return { status: "ok", data: { uri: input.uri, starred: true } };
  });
  server.on(apiDef.task.unstar, async ({ input }) => {
    state.unstarTask(input.uri);
    return { status: "ok", data: { uri: input.uri, starred: false } };
  });

  // ── subject ──
  server.on(apiDef.subject.add, async ({ input }) => {
    subject.addSubject(input.path, input.label);
    return { status: "ok", data: { path: input.path } };
  });
  server.on(apiDef.subject.list, async () => {
    return { status: "ok", data: { subjects: subject.listSubjects() } };
  });
  server.on(apiDef.subject.remove, async ({ input }) => {
    subject.removeSubject(input.path);
    return { status: "ok", data: { path: input.path } };
  });

  // ── ui ──
  server.on(apiDef.ui.tree, async ({ input }) => {
    return { status: "ok", data: taskTree.renderTreeText(taskTree.loadTaskTree(input.all)) };
  });
  server.on(apiDef.ui.status, () => ({
    status: "ok",
    data: { pid: process.pid, uptime: process.uptime(), memory: process.memoryUsage().heapUsed },
  }));

  // ── doctor ──
  server.on(apiDef.doctor, async () => {
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
  });

  // ── loadTaskTree / getTask ──
  server.on(apiDef.loadTaskTree, async ({ input }) => {
    return taskTree.loadTaskTree(input.allTasks);
  });
  server.on(apiDef.getTask, async ({ input }) => {
    return state.getTask(input.uri);
  });

  // ── agent ──
  server.on(apiDef.agent.chat, async ({ input }) => {
    const client = await getAgentClient();
    const result = await client.chat(input.model, input.messages);
    return { role: result.role, content: result.content };
  });
  server.on(apiDef.agent.chatStream, async function* ({ input }) {
    const client = await getAgentClient();
    for await (const delta of client.streamChat(input.model, input.messages)) {
      yield delta;
    }
  });
  server.on(apiDef.agent.listModels, () => [
    { id: "llama3.2", name: "Llama 3.2" },
    { id: "hermes", name: "Hermes Agent" },
  ]);
  server.on(apiDef.agent.status, async ({ input }) => {
    const client = await getAgentClient();
    const s = await client.getAgentStatus(input.agentId);
    return { agentId: s.agentId, state: s.state, model: s.model };
  });

  // ── llmProxy ──
  server.on(apiDef.llmProxy.status, async () => {
    const proxy = await getLlmProxy();
    return { running: proxy.isRunning, port: 8000 };
  });
  server.on(apiDef.llmProxy.start, async () => {
    const proxy = await getLlmProxy();
    proxy.start();
    return { status: "ok" };
  });
  server.on(apiDef.llmProxy.stop, async () => {
    const proxy = await getLlmProxy();
    proxy.stop();
    return { status: "ok" };
  });

  // ── log ──
  server.on(apiDef.log.read, async ({ input }) => {
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
  });

  // ── ref ──
  server.on(apiDef.ref.sync, async ({ input }) => {
    const result = await syncRefs({
      all: input.all,
      scope: input.scope,
      concurrency: input.concurrency,
    });
    return { status: "ok", data: result };
  });
  server.on(apiDef.ref.list, async ({ input }) => {
    return { status: "ok", data: refList(input.all) };
  });
  server.on(apiDef.ref.status, async () => {
    const paths = checkRefPaths();
    const missing = paths.filter((p) => !p.exists);
    return {
      status: "ok",
      data: { total: paths.length, missing: missing.length, paths },
    };
  });
  server.on(apiDef.ref.add, async ({ input }) => {
    return { status: "ok", data: { added: addSource(input.url) } };
  });
  server.on(apiDef.ref.remove, async ({ input }) => {
    const removed = removeSource(input.name);
    if (!removed) return { status: "error", msg: `未找到 source: ${input.name}` };
    return { status: "ok", data: { removed } };
  });

  return server;
}
