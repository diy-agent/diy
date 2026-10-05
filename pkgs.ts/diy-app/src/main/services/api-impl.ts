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
import { currentGitBranch, homeDisplayOf, repoDisplayOf } from "../core/instance-identity";
import { readRuntimeConfig } from "../../runtime";
import * as health from "./health";
import { refList, checkRefPaths } from "../core/ref";
import { syncRefs } from "./ref-sync";
import { addSource, removeSource } from "./ref-config";
import { apiDef } from "./api-def";
import { TaskDetailSchema } from "../../shared/task-detail";
import { noteRendererTouch } from "./runtime-context";
import type { CompactPolicy, ToolOutputMode } from "../../shared/context/compaction";
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
      // 展示形式与运行环境：窗口标题（main 与 renderer 两侧同源）与设置页状态用。
      // 缩写基准是**真实家目录**（不是 $HOME）：隔离/测试实例的 DIY_HOME === $HOME，
      // 用 $HOME 缩会得到 `~`，把 /tmp 临时根伪装成用户家目录（见 core/instance-identity.ts）。
      diyHomeDisplay: homeDisplayOf(ac.diyHome),
      repoDisplay: repoDisplayOf(),
      env: readRuntimeConfig().env,
      // 当前运行代码所在 git 分支：标题据此判断「哪个 worktree 的构建」，拿不到时空串
      branch: currentGitBranch() ?? "",
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
    // **整份展开交给契约 schema**：既不是手写键清单，也不只是 `...t` 展开 ——
    // 载荷形状由 shared/task-detail.ts 的 TaskDetailSchema（单一真源）决定，多余键自动剥掉。
    //
    // 历史教训（真实缺陷，两处手抄导致）：handler 里手抄一份键清单、api-def 的 output 白名单再抄一份，
    // 漏一处就静默丢字段（zod .object() 会 strip 未声明键）。实测漏过 change_type / module /
    // priority / persona —— 详情面板恒显示"未设置"、写入其实成功（数据在文件里），
    // 用户视角是"填了看不见、改完像没生效"。结论：只要人还写第二遍就一定会漏，故收敛成单一真源。
    return {
      status: "ok",
      data: TaskDetailSchema.parse({
        ...t,
        project_path: pinfo?.path,
        project_label: pinfo?.label,
        ui_drafts: d ? { base_updated: d.base_updated, saved: d.saved, fields: d.fields } : null,
      }),
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

  // —— agent.persona —— 人物配置（模型/参数/行为指令的唯一真源；任务只持有**引用（id）**）——
  binding.on(app.agent.persona.list, async () => {
    const { listPersonas, defaultPersonaId } = await import("../core/persona");
    const { diyHome, getTask } = await import("../core/state");
    const { listTasks } = await import("../core/task");
    const home = diyHome();
    // 引用计数：改人物是**影响所有引用者**的操作，界面必须先看得见影响面
    // （否则「统一修改」退化成盲改）。一次全库扫描，只在打开面板/列表时发生。
    const counts = new Map<string, number>();
    let followCount = 0;
    for (const uri of listTasks()) {
      const id = getTask(uri)?.persona;
      // 没有 persona 键 = **跟随缺省**（不写键就是跟随，见 core/task.ts 与 core/persona.ts）
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      else followCount++;
    }
    return {
      default: defaultPersonaId(home),
      personas: listPersonas(home).map((p) => ({ ...p, taskCount: counts.get(p.id) ?? 0 })),
      // 跟随者不属于任何具体人物，但对"改缺省会影响多少任务"是必须可见的事实
      followCount,
    };
  });

  binding.on(app.agent.persona.set, async ({ input }) => {
    const { loadPersonas, savePersonas, assertPersonaDef, personaByIdOrName } = await import("../core/persona");
    const { diyHome } = await import("../core/state");
    const { reasoningOf } = await import("../../shared/models");
    const { nextPersonaId } = await import("../../shared/persona");
    const home = diyHome();
    const file = loadPersonas(home);
    // id 优先、名字兜底（CLI 便利）：人记得的是名字，机器需要的是 id
    const target = input.id ? personaByIdOrName(home, input.id) : null;
    if (input.id && !target) throw new Error(`人物 ${input.id} 不存在（可用 diy agent persona list 查看）`);
    const id = target?.id ?? nextPersonaId(Object.keys(file.personas));
    const model = input.model ?? target?.model;
    if (!model) throw new Error(`新建人物必须指定 model（可选模型见 diy agent local models）`);
    const def = {
      name: input.name ?? target?.name ?? `人物${id}`,
      model,
      // 换模型时档位可能不在新模型的支持集内：未显式给档位就取新模型的默认档
      // （沿用旧档会写出一个上游必拒的组合，写入侧直接拦住）
      reasoningEffort:
        input.reasoningEffort ??
        (target && target.model === model ? target.reasoningEffort : reasoningOf(model).default),
      instructions: input.instructions ?? target?.instructions ?? "",
    };
    assertPersonaDef(def);
    savePersonas(home, { ...file, personas: { ...file.personas, [id]: def } });
    return { id, ...def };
  });

  binding.on(app.agent.persona.setDefault, async ({ input }) => {
    const { loadPersonas, savePersonas, personaByIdOrName } = await import("../core/persona");
    const { diyHome } = await import("../core/state");
    const home = diyHome();
    const file = loadPersonas(home);
    const target = personaByIdOrName(home, input.id);
    if (!target) throw new Error(`人物 ${input.id} 不存在（可用 diy agent persona list 查看）`);
    savePersonas(home, { ...file, default: target.id });
    return { default: target.id };
  });

  // —— agent.local —— 本地自定义 agent（ai-sdk 块协议，与 ACP 独立）
  binding.on(app.agent.local.chat, async function* ({ input }) {
    noteRendererTouch("diy.agent.local.chat", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    const agent = getLocalAgent();
    // --mode 给出 = 入队待投递（不启动轮次）；省略 = 立即开一轮。
    if (input.mode) {
      agent.steerAdd(input.taskUri, input.mode, input.message);
      return;
    }
    for await (const op of agent.chat(input.taskUri, input.message, input.model, input.reasoningEffort)) {
      yield JSON.stringify(op);
    }
  });
  binding.on(app.agent.local.cancel, async ({ input }) => {
    noteRendererTouch("diy.agent.local.cancel", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return { cancelled: getLocalAgent().cancel(input.taskUri) };
  });
  // 运行态查询：不经 LocalAgentManager（它只在"这个 task 的会话被碰过"时才有 session），
  // 直接读 runtime-context 的内存表 —— 那才是「此刻主进程真正在跑哪些轮次」的权威。
  binding.on(app.agent.local.running, async () => {
    const { activeTurnList } = await import("./runtime-context");
    return { active: activeTurnList() };
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
  binding.on(app.agent.local.steer.list, async ({ input }) => {
    noteRendererTouch("diy.agent.local.steer.list", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().steerList(input.taskUri);
  });
  binding.on(app.agent.local.steer.cancel, async ({ input }) => {
    noteRendererTouch("diy.agent.local.steer.cancel", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().steerCancel(input.taskUri, input.id);
  });
  binding.on(app.agent.local.steer.toggleMode, async ({ input }) => {
    noteRendererTouch("diy.agent.local.steer.toggleMode", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().steerToggleMode(input.taskUri, input.id);
  });
  binding.on(app.agent.local.steer.reorder, async ({ input }) => {
    noteRendererTouch("diy.agent.local.steer.reorder", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().steerReorder(input.taskUri, input.ids);
  });
  binding.on(app.agent.local.models, async () => {
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().listModels();
  });
  binding.on(app.agent.local.limits, async () => {
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().getLimits();
  });
  // 逐步用量账本：结构化直出（分组/汇总在 shared/usage 的纯函数里，两端同一套口径）
  binding.on(app.agent.local.usage, async ({ input }) => {
    noteRendererTouch("diy.agent.local.usage", input.taskUri);
    const { readUsage } = await import("./usage-report");
    return readUsage(input.taskUri);
  });
  // ── 压缩（compact）：少发 ≠ 销毁；历史原地保留可查、可撤销 ──
  // CLI/UI 传来的散字段 → 策略对象（缺省字段由 normalizePolicy 兜底；undefined 覆盖成默认值）
  const policyOf = (i: Record<string, unknown>): Partial<CompactPolicy> => ({
    keepTurns: i.keepTurns as number | undefined,
    toolOutput: i.toolOutput as ToolOutputMode | undefined,
    headtail: {
      triggerLines: i.triggerLines as number,
      headLines: i.headLines as number,
      tailLines: i.tailLines as number,
      maxLineChars: i.maxLineChars as number,
      maxKeepBytes: i.maxKeepBytes as number,
    },
    summary: i.summary as boolean | undefined,
  });
  binding.on(app.agent.local.compact, async ({ input }) => {
    noteRendererTouch("diy.agent.local.compact", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().compact(input.taskUri, policyOf(input), "cli");
  });
  binding.on(app.agent.local.compactPreview, async ({ input }) => {
    noteRendererTouch("diy.agent.local.compactPreview", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().compactPreview(input.taskUri, policyOf(input));
  });
  binding.on(app.agent.local.undoCompact, async ({ input }) => {
    noteRendererTouch("diy.agent.local.undoCompact", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return { undone: getLocalAgent().undoCompact(input.taskUri, input.ref) };
  });
  binding.on(app.agent.local.generations, async ({ input }) => {
    noteRendererTouch("diy.agent.local.generations", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().generations(input.taskUri);
  });
  binding.on(app.agent.local.generationOps, async ({ input }) => {
    noteRendererTouch("diy.agent.local.generationOps", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().generationOps(input.taskUri, input.seq);
  });
  // 会话用量报表（人读表格）：与 UI 同源同口径，只是在这里渲染成等宽文本
  binding.on(app.agent.usage, async ({ input }) => {
    const { readUsage, renderUsageSteps, renderUsageByAgent } = await import("./usage-report");
    const steps = readUsage(input.task);
    return input.byAgent
      ? renderUsageByAgent(steps, { last: input.last })
      : renderUsageSteps(steps, { last: input.last, cost: input.cost });
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
    const { contextLimitOf } = await import("./local-agent");
    const { personaForTask } = await import("../core/persona");
    // project 以 taskUri 为准：两者指向不同项目时（只有 CLI 能造成）system 与 tools/cwd 会错配
    const project = input.taskUri ? projectFromUri(input.taskUri) || input.project : input.project;
    const base = assembleSystem(diyHome(), project, {
      taskUri: input.taskUri,
      drafts: input.drafts,
      // 预算随预览模型变（与真发同一套推导）：显式模型优先，否则按任务当前人物
      contextLimitTokens: contextLimitOf(input.model ?? personaForTask(diyHome(), input.taskUri ?? "").model),
      // 试验场「模版结构树」要 trace；真发（local-agent）不传
      trace: true,
    });
    // 无任务场景：只渲染文本
    if (!input.taskUri) {
      return { ...base, requestBody: null, requestNote: "无任务场景：仅渲染 system 文本" };
    }
    const { previewSimulatedRequest } = await import("./local-agent");
    const sim = await previewSimulatedRequest({ taskUri: input.taskUri, system: base.system, model: input.model });
    // ⚠️ 这条链是**模版线**（assembleSystem 渲染 _system.md + AGENTS.md 链），
    // 而真发已切到 Context Tree 投递（见 /diy.sh context lab 与 runTurn 的 buildDelivery）。
    // 所以这里造出来的 body 只是"模版渲染出来的样子"，不是真发形态 —— note 必须说清，否则误导。
    return {
      ...base,
      requestBody: sim.body,
      requestNote: `${sim.note}（注：这是**模版链**的仿真；真发已切 Context Tree 投递，见上下文树页的请求预览）`,
    };
  });

  // ── context（上下文树页：**当前任务的真实上下文**，不落盘、不发 LLM）──
  binding.on(app.context.config, async () => {
    const { loadSystemPlaces, contextConfigFile } = await import("../core/context-config");
    const { defaultSystemPlaces } = await import("../../shared/context/delivery");
    const { existsSync } = await import("node:fs");
    const { diyHome } = await import("../core/state");
    return {
      systemPlaces: loadSystemPlaces(diyHome()),
      defaults: defaultSystemPlaces(),
      fromFile: existsSync(contextConfigFile(diyHome())),
    };
  });
  binding.on(app.context.setConfig, async ({ input }) => {
    const { saveSystemPlaces } = await import("../core/context-config");
    const { diyHome } = await import("../core/state");
    return { systemPlaces: saveSystemPlaces(diyHome(), input.systemPlaces) };
  });
  binding.on(app.context.candidates, async () => {
    const { PLACE_CANDIDATES, defaultSystemPlaces } = await import("../../shared/context/preview");
    return { candidates: PLACE_CANDIDATES, defaultSystem: defaultSystemPlaces() };
  });
  binding.on(app.context.lab, async ({ input }) => {
    const { assembleGlobals } = await import("./prompt-registry");
    const { diyHome, projectFromUri } = await import("../core/state");
    const { loadSystemPlaces } = await import("../core/context-config");
    const { buildLab } = await import("../../shared/context/preview");
    const taskUri = input.taskUri ?? "";
    const project = projectFromUri(taskUri) || input.project;
    // 真实数据：与真发同一条组装链（同样的 AGENTS.md 链、同样的 cwd 推导）
    const globals = assembleGlobals(diyHome(), project, { taskUri }) as unknown as Record<string, unknown>;
    // 空数组 = 调用方还没决定（UI 首帧）→ 读**真源**（与真发同一份）；
    // 只有明确给了名单才尊重它（页面把开关状态传进来做即时预览）
    const systemPlaces = input.systemPlaces?.length ? input.systemPlaces : loadSystemPlaces(diyHome());
    // 先按纯函数算出两份投递，再用**真发的构造链**把请求体拼出来：
    // system = system 份；末条 user = runtime 份（144 的设计：runtime 作为尾部 user 消息）
    const lab = buildLab(globals, systemPlaces, taskUri);
    let request: { body: Record<string, unknown> | null; note: string; model: string } = {
      body: null,
      note: "无任务场景：仅组装上下文，未构造请求体",
      model: "",
    };
    if (taskUri) {
      const { previewSimulatedRequest, DEFAULT_MODEL } = await import("./local-agent");
      const model = input.model || DEFAULT_MODEL;
      const sim = await previewSimulatedRequest({
        taskUri,
        system: lab.system.text,
        model,
        // runtime 作为独立 user 消息插在末条之前 —— 与真发（runTurn 的 withRuntime）同形
        runtime: lab.runtime.text,
      });
      request = { body: sim.body, note: sim.note, model };
    }
    return { ...lab, request };
  });

  binding.on(app.context.steps, async ({ input }) => {
    const { readDeliverySteps } = await import("./local-agent");
    const { summarizeSteps } = await import("../../shared/context/steps");
    const records = readDeliverySteps(input.taskUri);
    return {
      total: records.length,
      steps: summarizeSteps(records, { limit: input.limit, withDiff: input.diff === true }),
    };
  });

  binding.on(app.context.stats, async ({ input }) => {
    const { readContextStats } = await import("../core/context-stats");
    const { summarizeStats } = await import("../../shared/context/stats");
    const { projectDir, projectFromUri } = await import("../core/state");
    // project 以 taskUri 为准（与 lab/diff 同一口径：两者不一致时只有 CLI 能造成）
    const project = input.taskUri ? projectFromUri(input.taskUri) || input.project : input.project;
    let records = readContextStats(projectDir(project));
    if (input.taskUri) records = records.filter((r) => r.taskUri === input.taskUri);
    const total = records.length;
    if (input.limit && input.limit > 0) records = records.slice(-input.limit);
    return { ...summarizeStats(records), records: total };
  });

  binding.on(app.context.diff, async ({ input }) => {
    const { readDeliverySteps } = await import("./local-agent");
    const { diffSteps } = await import("../../shared/context/steps");
    const records = readDeliverySteps(input.taskUri);
    if (records.length === 0) return null;
    // 选中第 N 步：与第 N-1 步比（两侧都在文件里）
    if (input.step !== undefined) {
      const idx = Math.trunc(input.step);
      const cur = records[idx - 1];
      const prev = idx - 1 >= 1 ? records[idx - 2] : null;
      if (!cur) return null;
      const d = prev ? diffSteps(prev, cur) : null;
      return {
        mode: "step" as const,
        base: prev ? { index: idx - 1, ts: prev.ts, turnId: prev.turnId } : null,
        target: { index: idx, ts: cur.ts, turnId: cur.turnId, model: cur.model },
        incomparable: d?.incomparable ?? false,
        changed: d?.changed ?? Object.keys(cur.valueHashes).sort(),
        systemDiffers: d?.systemDiffers ?? true,
        runtimeDiffers: d?.runtimeDiffers ?? true,
        systemDiff: d?.systemDiff ?? [],
        runtimeDiff: d?.runtimeDiff ?? [],
      };
    }
    // 未选中：**当前变量树** vs 最后一步（"我现在改的东西会带来什么变化"）
    const { assembleGlobals } = await import("./prompt-registry");
    const { diyHome, projectFromUri } = await import("../core/state");
    const { buildDelivery } = await import("../../shared/context/delivery");
    const { loadSystemPlaces } = await import("../core/context-config");
    const project = projectFromUri(input.taskUri) || input.project;
    const globals = assembleGlobals(diyHome(), project, { taskUri: input.taskUri }) as unknown as Record<string, unknown>;
    const now = buildDelivery(globals, input.systemPlaces?.length ? input.systemPlaces : loadSystemPlaces(diyHome()));
    const last = records[records.length - 1]!;
    const d = diffSteps(last, {
      ...last,
      wireVersion: now.wireVersion,
      valueHashes: now.valueHashes,
      systemText: now.system.text,
      runtimeText: now.runtime.text,
    });
    return {
      mode: "live" as const,
      base: { index: records.length, ts: last.ts, turnId: last.turnId },
      target: null,
      incomparable: d.incomparable,
      changed: d.changed,
      systemDiffers: d.systemDiffers,
      runtimeDiffers: d.runtimeDiffers,
      systemDiff: d.systemDiff,
      runtimeDiff: d.runtimeDiff,
    };
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
