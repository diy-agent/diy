/**
 * api-impl.ts — Main 进程 RPC handler 绑定（handle 分离）
 *
 * 从 api-def.ts 导入纯 meta，通过 binding.onUnary/onServerStream 逐个绑定实现。
 * 业务逻辑在这里，schema 定义在 api-def.ts。
 * 命名体系：diy.app.*（Main 进程域）。
 */

import type { ServerBinding } from "@diy/rpc";
import { ChannelServerBinding } from "@diy/rpc";
import type { EnvelopeTransport } from "@diy/rpc";
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

const app = apiDef.diy.app;

/**
 * 把 Main 侧所有 diy.app.* handler 绑定到给定 ServerBinding（传输无关）。
 *
 * apiDef 已 router() 包裹（全名回写），binding 可以是 HttpServerBinding（生产）
 * 或 ChannelServerBinding（测试）。转发 diy.ui.* 由调用方在 binding 上 onForward。
 */
export function bindAppHandlers(binding: ServerBinding): void {

  // ── task ──
  binding.onUnary(app.task.create, async ({ input }) => {
    return { status: "ok", data: { uri: task.createTask(input as any) } };
  });
  binding.onUnary(app.task.list, async ({ input }) => {
    return { status: "ok", data: { tasks: task.listTasks(input.subject) } };
  });
  binding.onUnary(app.task.show, async ({ input }) => {
    const t = state.getTask(input.uri);
    if (!t) return { status: "error", msg: `任务 ${input.uri} 不存在` };
    return { status: "ok", data: t };
  });
  binding.onUnary(app.task.edit, async ({ input }) => {
    const { uri, ...changes } = input;
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v !== undefined) filtered[k] = v as string;
    }
    task.updateTask(uri, filtered);
    return { status: "ok", data: { uri } };
  });
  binding.onUnary(app.task.delete, async ({ input }) => {
    task.deleteTask(input.uri);
    return { status: "ok", data: { uri: input.uri } };
  });
  binding.onUnary(app.task.star, async ({ input }) => {
    state.starTask(input.uri);
    return { status: "ok", data: { uri: input.uri, starred: true } };
  });
  binding.onUnary(app.task.unstar, async ({ input }) => {
    state.unstarTask(input.uri);
    return { status: "ok", data: { uri: input.uri, starred: false } };
  });

  // ── subject ──
  binding.onUnary(app.subject.add, async ({ input }) => {
    subject.addSubject(input.path, input.label);
    return { status: "ok", data: { path: input.path } };
  });
  binding.onUnary(app.subject.list, async () => {
    return { status: "ok", data: { subjects: subject.listSubjects() } };
  });
  binding.onUnary(app.subject.remove, async ({ input }) => {
    subject.removeSubject(input.path);
    return { status: "ok", data: { path: input.path } };
  });

  // ── getAppStatus（供 renderer diy.ui.status 反向调用）──
  binding.onUnary(app.getAppStatus, () => ({
    status: "ok",
    data: { pid: process.pid, uptime: process.uptime(), memory: process.memoryUsage().heapUsed },
  }));

  // ── doctor ──
  binding.onUnary(app.doctor, async () => {
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
  binding.onUnary(app.loadTaskTree, async ({ input }) => {
    return taskTree.loadTaskTree(input.allTasks);
  });
  binding.onUnary(app.getTask, async ({ input }) => {
    return state.getTask(input.uri);
  });

  // ── agent ──
  binding.onUnary(app.agent.chat, async ({ input }) => {
    const client = await getAgentClient();
    const result = await client.chat(input.model, input.messages);
    return { role: result.role, content: result.content };
  });
  binding.onServerStream(app.agent.chatStream, async function* ({ input }) {
    const client = await getAgentClient();
    for await (const delta of client.streamChat(input.model, input.messages)) {
      yield delta;
    }
  });
  binding.onUnary(app.agent.listModels, () => [
    { id: "llama3.2", name: "Llama 3.2" },
    { id: "hermes", name: "Hermes Agent" },
  ]);
  binding.onUnary(app.agent.status, async ({ input }) => {
    const client = await getAgentClient();
    const s = await client.getAgentStatus(input.agentId);
    return { agentId: s.agentId, state: s.state, model: s.model };
  });

  // ── llmProxy ──
  binding.onUnary(app.llmProxy.status, async () => {
    const proxy = await getLlmProxy();
    return { running: proxy.isRunning, port: 8000 };
  });
  binding.onUnary(app.llmProxy.start, async () => {
    const proxy = await getLlmProxy();
    proxy.start();
    return { status: "ok" };
  });
  binding.onUnary(app.llmProxy.stop, async () => {
    const proxy = await getLlmProxy();
    proxy.stop();
    return { status: "ok" };
  });

  // ── log ──
  binding.onUnary(app.log.read, async ({ input }) => {
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
  binding.onUnary(app.ref.sync, async ({ input }) => {
    const result = await syncRefs({
      all: input.all,
      scope: input.scope,
      concurrency: input.concurrency,
    });
    return { status: "ok", data: result };
  });
  binding.onUnary(app.ref.list, async ({ input }) => {
    return { status: "ok", data: refList(input.all) };
  });
  binding.onUnary(app.ref.status, async () => {
    const paths = checkRefPaths();
    const missing = paths.filter((p) => !p.exists);
    return {
      status: "ok",
      data: { total: paths.length, missing: missing.length, paths },
    };
  });
  binding.onUnary(app.ref.add, async ({ input }) => {
    return { status: "ok", data: { added: addSource(input.url) } };
  });
  binding.onUnary(app.ref.remove, async ({ input }) => {
    const removed = removeSource(input.name);
    if (!removed) return { status: "error", msg: `未找到 source: ${input.name}` };
    return { status: "ok", data: { removed } };
  });

}

/** 兼容旧用法：把 Main 侧 handlers 绑到某 transport 的 ChannelServerBinding（如 IPC） */
export function bindApi(transport: EnvelopeTransport): ServerBinding {
  const binding = new ChannelServerBinding(transport);
  bindAppHandlers(binding);
  return binding;
}
