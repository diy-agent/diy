/**
 * api-impl.ts — Main 进程 RPC handler 绑定（handle 分离）
 *
 * 从 api-def.ts 导入纯 meta，通过 binding.on(meta, handler) 逐个绑定实现。
 * 业务逻辑在这里，schema 定义在 api-def.ts。
 * 命名体系：diy.*（Main 进程域，本地处理）。diy.ui.* 由调用方 onForward 转发。
 */

import type { ServerBinding } from "@diy/rpc";
import { ChannelServerBinding } from "@diy/rpc";
import type { EnvelopeTransport } from "@diy/rpc";
import * as task from "../core/task";
import * as project from "../core/project";
import * as state from "../core/state";
import * as taskTree from "../core/task-tree";
import { AppConfig } from "../core/app-config";
import { platform, arch, release, totalmem, freemem } from "node:os";
import * as health from "./health";
import { refList, checkRefPaths } from "../core/ref";
import { syncRefs } from "./ref-sync";
import { addSource, removeSource } from "./ref-config";
import { apiDef } from "./api-def";

let _sessionPool: any = null;
/**
 * 实际 RPC 监听端口，由入口在绑定完成后回填。
 * 不能靠 app.port 文件推：serve 模式不写该文件，读到的会是 Electron 留下的陈旧值。
 */
let _rpcPort = 0;
export function setRpcPort(port: number): void {
  _rpcPort = port;
}
async function getSessionPool() {
  if (!_sessionPool) {
    const { TaskSessionPoolV2 } = await import("./acp-sessions-v2");
    _sessionPool = new TaskSessionPoolV2();
    await _sessionPool.ready();
  }
  return _sessionPool;
}
let _llmProxyInstance: any = null;
async function getLlmProxy() {
  if (!_llmProxyInstance) {
    const { LlmProxy } = await import("./llm-proxy");
    _llmProxyInstance = new LlmProxy();
  }
  return _llmProxyInstance;
}

const app = apiDef.diy;

/**
 * 把 Main 侧所有 diy.* handler 绑定到给定 ServerBinding（传输无关）。
 *
 * apiDef 已 router() 包裹（全名回写），binding 可以是 HttpServerBinding（生产）
 * 或 ChannelServerBinding（测试）。转发 diy.ui.* 由调用方在 binding 上 onForward。
 */
export function bindAppHandlers(binding: ServerBinding): void {

  // ── task ──
  binding.on(app.task.create, async ({ input }) => {
    return { status: "ok", data: { uri: task.createTask(input as any) } };
  });
  binding.on(app.task.list, async ({ input }) => {
    return { status: "ok", data: { tasks: task.listTasks(input.project) } };
  });
  binding.on(app.task.show, async ({ input }) => {
    const t = state.getTask(input.uri);
    if (!t) return { status: "error", msg: `任务 ${input.uri} 不存在` };
    return { status: "ok", data: t };
  });
  binding.on(app.task.edit, async ({ input }) => {
    const { uri, ...changes } = input;
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v !== undefined) filtered[k] = v as string;
    }
    task.updateTask(uri, filtered);
    return { status: "ok", data: { uri } };
  });
  binding.on(app.task.move, async ({ input }) => {
    task.moveTask(input.uri, input.parent);
    return { status: "ok", data: { uri: input.uri } };
  });
  binding.on(app.task.delete, async ({ input }) => {
    task.deleteTask(input.uri);
    return { status: "ok", data: { uri: input.uri } };
  });
  binding.on(app.task.star, async ({ input }) => {
    state.starTask(input.uri);
    return { status: "ok", data: { uri: input.uri, starred: true } };
  });
  binding.on(app.task.unstar, async ({ input }) => {
    state.unstarTask(input.uri);
    return { status: "ok", data: { uri: input.uri, starred: false } };
  });

  // ── project ──
  binding.on(app.project.create, async ({ input }) => {
    const id = project.createProject(input.path, {
      label: input.label,
      desc: input.desc,
      state: input.state,
    });
    return { status: "ok", data: { id } };
  });
  binding.on(app.project.list, async () => {
    return { status: "ok", data: { projects: project.listProjects() } };
  });
  binding.on(app.project.remove, async ({ input }) => {
    project.removeProject(input.id);
    return { status: "ok", data: { id: input.id } };
  });

  // ── getAppStatus（供 renderer diy.ui.status 反向调用）──
  binding.on(app.getAppStatus, () => ({
    status: "ok",
    data: { pid: process.pid, uptime: process.uptime(), memory: process.memoryUsage().heapUsed },
  }));

  // ── getAppInfo（Electron / serve / CLI 三处共用，版本字段对非 Electron 环境降级）──
  binding.on(app.getAppInfo, () => {
    const ac = new AppConfig(state.diyHome());
    const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);
    return {
      port: _rpcPort,
      diyHome: ac.diyHome,
      cache: ac.cache,
      userData: ac.electronUserData,
      // serve 模式是纯 Node，这两个版本字段不存在 —— 必须给可读的占位而不是 undefined，
      // 否则 zod output 校验直接失败，界面又变成一片空白
      electron: process.versions.electron ?? "—（非 Electron）",
      node: process.versions.node,
      chrome: process.versions.chrome ?? "—（非 Electron）",
      platform: `${platform()} ${arch()} (${release()})`,
      pid: process.pid,
      memory: `${gb(totalmem())} GB total, ${gb(freemem())} GB free`,
    };
  });

  // ── doctor ──
  binding.on(app.doctor, async () => {
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
  binding.on(app.loadTaskTree, async ({ input }) => {
    return { status: "ok", data: taskTree.loadTaskTree(input.allTasks) };
  });
  binding.on(app.getTask, async ({ input }) => {
    const t = state.getTask(input.uri);
    // 未找到 → data: null（truthy 的壳对象会让 renderer 守卫失效）
    if (!t) return { status: "error", data: null };
    return { status: "ok", data: { uri: t.uri, title: t.title, state: t.state, project: t.project, parent: t.parent, detail: t.detail, body: t.body, created: t.created, updated: t.updated } };
  });

  // ── pickProjectDirectory（renderer「选择目录」按钮反向调用）──
  binding.on(app.pickProjectDirectory, async () => {
    // dialog 是 Electron main 专属；serve(Web) 模式无 dialog，返回 canceled
    try {
      const { dialog } = await import("electron");
      const r = await dialog.showOpenDialog({
        title: "选择项目目录",
        properties: ["openDirectory", "createDirectory"],
      });
      const path = r.filePaths?.[0];
      if (r.canceled || !path) {
        return { status: "ok", data: { canceled: true } };
      }
      return { status: "ok", data: { canceled: false, path } };
    } catch (err) {
      console.error(`[pickProjectDirectory] 打开目录选择器失败: ${err}`);
      return { status: "ok", data: { canceled: true } };
    }
  });

  // ── agent ──
  binding.on(app.agent.chat, async ({ input }) => {
    const pool = await getSessionPool();
    const result = await pool.chat(input.taskUri, input.model, input.messages);
    return { role: result.role, content: result.content };
  });
  binding.on(app.agent.chatStream, async function* ({ input }) {
    const pool = await getSessionPool();
    for await (const delta of pool.streamChat(input.taskUri, input.model, input.messages)) {
      yield delta;
    }
  });
  binding.on(app.agent.chatStreamEvents, async function* ({ input }) {
    const pool = await getSessionPool();
    for await (const ev of pool.streamChatEvents(input.taskUri, input.model, input.messages)) {
      yield ev;
    }
  });
  binding.on(app.agent.listModels, async () => {
    const pool = await getSessionPool();
    const models = await pool.listModels();
    return models.map((m: { modelId: string; name?: string }) => ({ id: m.modelId, name: m.name ?? m.modelId }));
  });
  binding.on(app.agent.status, async ({ input }) => {
    const pool = await getSessionPool();
    const s = await pool.status(input.taskUri);
    return { taskUri: s.taskUri, state: s.state, model: s.model };
  });

  // autoApprovePermission 状态（内存态，重启重置为 true）
  let _autoApprove = true;
  binding.on(app.agent.getAutoApprove, async () => {
    return { enabled: _autoApprove };
  });
  binding.on(app.agent.setAutoApprove, async ({ input }) => {
    _autoApprove = input.enabled;
    return { enabled: _autoApprove };
  });
  binding.on(app.agent.closeSession, async ({ input }) => {
    const pool = await getSessionPool();
    await pool.closeSession(input.taskUri);
    return { closed: true };
  });
  binding.on(app.agent.setModel, async ({ input }) => {
    const pool = await getSessionPool();
    await pool.setModel(input.taskUri, input.model);
    return { success: true };
  });

  // ── llmProxy ──
  binding.on(app.llmProxy.status, async () => {
    const proxy = await getLlmProxy();
    return { running: proxy.isRunning, port: 8000 };
  });
  binding.on(app.llmProxy.start, async () => {
    const proxy = await getLlmProxy();
    proxy.start();
    return { status: "ok" };
  });
  binding.on(app.llmProxy.stop, async () => {
    const proxy = await getLlmProxy();
    proxy.stop();
    return { status: "ok" };
  });

  // ── log ──
  binding.on(app.log.read, async ({ input }) => {
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
  binding.on(app.ref.sync, async ({ input }) => {
    const result = await syncRefs({
      all: input.all,
      scope: input.scope,
      concurrency: input.concurrency,
    });
    return { status: "ok", data: result };
  });
  binding.on(app.ref.list, async ({ input }) => {
    return { status: "ok", data: refList(input.all) };
  });
  binding.on(app.ref.status, async () => {
    const paths = checkRefPaths();
    const missing = paths.filter((p) => !p.exists);
    return {
      status: "ok",
      data: { total: paths.length, missing: missing.length, paths },
    };
  });
  binding.on(app.ref.add, async ({ input }) => {
    return { status: "ok", data: { added: addSource(input.url) } };
  });
  binding.on(app.ref.remove, async ({ input }) => {
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
