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
import { DRAFT_FIELDS, clearDrafts, readDrafts, writeDrafts, type DraftField } from "../core/drafts";
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
import { noteRendererTouch } from "./runtime-context";
import { readFileWindow, formatReadOutput, ReadWindowError } from "../core/file-read";
import { resolve as resolvePath } from "node:path";

/**
 * 实际 RPC 监听端口，由入口在绑定完成后回填。
 * 不能靠 app.port 文件推：serve 模式不写该文件，读到的会是 Electron 留下的陈旧值。
 */
let _rpcPort = 0;
export function setRpcPort(port: number): void {
  _rpcPort = port;
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
    // project 只存 id；同时回填 path/label，CLI 才看得到原 subject 路径
    const info = project.getProjectInfo(t.project ?? "");
    // 草稿随任务一并返回：renderer 少一次往返即拿到恢复所需的一切
    const d = readDrafts(input.uri);
    return {
      status: "ok",
      data: {
        ...t,
        project_path: info?.path,
        project_label: info?.label,
        ui_drafts: d ? { base_updated: d.base_updated, saved: d.saved, fields: d.fields } : null,
      },
    };
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
    // 草稿在任务目录 .diy/ 内，随 rmSync(dir, {recursive:true}) 一并删除，无需单独清理
    task.deleteTask(input.uri);
    return { status: "ok", data: { uri: input.uri } };
  });

  // ── 未提交草稿（半编辑数据：丢不起，故落盘且写失败必须冒泡）──
  binding.on(app.task.drafts.show, async ({ input }) => {
    const d = readDrafts(input.uri);
    return { status: "ok", data: d ? { base_updated: d.base_updated, saved: d.saved, fields: d.fields } : null };
  });
  binding.on(app.task.drafts.set, async ({ input }) => {
    // undefined = 未提供（保持原值）；"" = 清除该字段 —— 由 writeDrafts 的 splitFields 落地
    const { uri, base_updated, ...rest } = input;
    const fields: Partial<Record<DraftField, string>> = {};
    for (const f of DRAFT_FIELDS) {
      const v = (rest as Record<string, string | undefined>)[f];
      if (v !== undefined) fields[f] = v;
    }
    const r = writeDrafts(uri, fields, base_updated);
    return { status: "ok", data: { base_updated: r.base_updated, saved: r.saved, fields: r.fields } };
  });
  binding.on(app.task.drafts.clear, async ({ input }) => {
    clearDrafts(input.uri, input.fields as DraftField[] | undefined);
    return { status: "ok" };
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
  binding.on(app.loadTaskTree, async () => {
    return { status: "ok", data: taskTree.loadTaskTree() };
  });
  binding.on(app.getTask, async ({ input }) => {
    const t = state.getTask(input.uri);
    // 未找到 → data: null（truthy 的壳对象会让 renderer 守卫失效）
    if (!t) return { status: "error", data: null };
    // project 只存 id（路径即分组）；同时回填 path/label，CLI/GUI 才看得到原 subject 路径
    const pinfo = project.getProjectInfo(t.project ?? "");
    // 草稿随任务返回（与 diy.task.show 同一契约）：renderer 只调这一个接口拿任务，
    // 少一次往返就少一处「忘记带草稿」的机会 —— 两个 handler 必须给同样的字段。
    const d = readDrafts(input.uri);
    return {
      status: "ok",
      data: {
        uri: t.uri, title: t.title, state: t.state, project: t.project,
        project_path: pinfo?.path, project_label: pinfo?.label,
        parent: t.parent, body: t.body,
        created: t.created, updated: t.updated,
        ui_drafts: d ? { base_updated: d.base_updated, saved: d.saved, fields: d.fields } : null,
      },
    };
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

  // —— watch —— 文件系统变更推送（serverStream：FileWatcher → RPC → renderer）
  // 在 diy.watch.*（Main 域）：diy.ui.* 会被 rpc-port 全量转发给 renderer，
  // 挂那里会与本地注册冲突（ServerBinding 抛「已注册」→ RPC 起不来）。
  binding.on(app.watch.fileChange, async function* () {
    const { fileWatcher } = await import("./file-watcher");
    for await (const change of fileWatcher.subscribe()) {
      yield change;
    }
  });

  // —— agent.local —— 本地自定义 agent（ai-sdk 块协议，与 ACP 独立）
  binding.on(app.agent.local.chat, async function* ({ input }) {
    noteRendererTouch("diy.agent.local.chat", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    for await (const op of getLocalAgent().chat(input.taskUri, input.message, input.model, input.reasoningEffort)) {
      yield JSON.stringify(op);
    }
  });
  binding.on(app.agent.local.cancel, async ({ input }) => {
    noteRendererTouch("diy.agent.local.cancel", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return { cancelled: getLocalAgent().cancel(input.taskUri) };
  });
  binding.on(app.agent.local.history, async ({ input }) => {
    noteRendererTouch("diy.agent.local.history", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().history(input.taskUri);
  });
  binding.on(app.agent.local.clear, async ({ input }) => {
    noteRendererTouch("diy.agent.local.clear", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return { cleared: getLocalAgent().clear(input.taskUri) };
  });
  binding.on(app.agent.local.models, async () => {
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().listModels();
  });
  binding.on(app.agent.local.limits, async () => {
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().getLimits();
  });

  // ── template（提示词模版试验场 spike）──
  binding.on(app.template.list, async ({ input }) => {
    const { listPrompts } = await import("./prompt-registry");
    const { diyHome } = await import("../core/state");
    return listPrompts(diyHome(), input.project);
  });
  binding.on(app.template.get, async ({ input }) => {
    const { getPrompt } = await import("./prompt-registry");
    const { diyHome } = await import("../core/state");
    return getPrompt(diyHome(), input.project, input.relpath);
  });
  binding.on(app.template.save, async ({ input }) => {
    const { savePrompt } = await import("./prompt-registry");
    const { diyHome } = await import("../core/state");
    return savePrompt(diyHome(), input.project, input.relpath, input.content);
  });
  binding.on(app.template.restore, async ({ input }) => {
    const { restorePrompt } = await import("./prompt-registry");
    const { diyHome } = await import("../core/state");
    return restorePrompt(diyHome(), input.project, input.relpath);
  });
  binding.on(app.template.preview, async ({ input }) => {
    const { assembleSystem } = await import("./prompt-registry");
    const { diyHome, projectFromUri } = await import("../core/state");
    const { contextLimitOf, DEFAULT_MODEL } = await import("./local-agent");
    // project 以 taskUri 为准：两者指向不同项目时（只有 CLI 能造成）system 与 tools/cwd 会错配
    const project = input.taskUri ? projectFromUri(input.taskUri) || input.project : input.project;
    const base = assembleSystem(diyHome(), project, {
      taskUri: input.taskUri,
      drafts: input.drafts,
      // 预算随预览模型变（与真发同一套推导）
      contextLimitTokens: contextLimitOf(input.model || DEFAULT_MODEL),
      // 试验场「模版结构树」要 trace；真发（local-agent）不传
      trace: true,
    });
    // 无任务场景：只渲染文本
    if (!input.taskUri) {
      return { ...base, requestBody: null, requestNote: "无任务场景：仅渲染 system 文本" };
    }
    const { previewSimulatedRequest } = await import("./local-agent");
    const sim = await previewSimulatedRequest({ taskUri: input.taskUri, system: base.system, model: input.model });
    return { ...base, requestBody: sim.body, requestNote: sim.note };
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

  // ── tool ──
  // 文件读取（行窗口 + 续读）：与内置 read 工具共用 core/file-read.ts。
  // 相对路径由 CLI 侧 parser 按调用方 cwd 解析成绝对路径（见 api-def 的 resolvePath 注解）；
  // 这里再 resolve 一次是给 renderer 等不走 parser 的调用方兜底（绝对路径 resolve 是恒等）。
  binding.on(app.tool.read, async ({ input }) => {
    const raw = (input.path ?? "").trim();
    if (!raw) throw new Error("path 不能为空");
    if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 1)) {
      throw new Error(`offset 必须是 >= 1 的整数（收到 ${input.offset}）`);
    }
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
      throw new Error(`limit 必须是 >= 1 的整数（收到 ${input.limit}）`);
    }
    const abs = resolvePath(raw);
    try {
      const window = await readFileWindow(abs, abs, { offset: input.offset, limit: input.limit });
      return formatReadOutput(window);
    } catch (e) {
      if (e instanceof ReadWindowError) throw new Error(e.message);
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") throw new Error(`文件不存在：${abs}`);
      if (code === "EISDIR") throw new Error(`${abs} 是目录（本命令只读文本文件；列目录请用 ls）`);
      throw e;
    }
  });

}

/** 兼容旧用法：把 Main 侧 handlers 绑到某 transport 的 ChannelServerBinding（如 IPC） */
export function bindApi(transport: EnvelopeTransport): ServerBinding {
  const binding = new ChannelServerBinding(transport);
  bindAppHandlers(binding);
  return binding;
}
