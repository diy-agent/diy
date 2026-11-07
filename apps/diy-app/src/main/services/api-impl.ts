/**
 * api-impl.ts — Main 进程 RPC handler 绑定（handle 分离）
 *
 * 从 api-def.ts 导入纯 meta，通过 binding.on(meta, handler) 逐个绑定实现。
 * 业务逻辑在这里，schema 定义在 api-def.ts。
 * 命名体系：diy.*（Main 进程域，本地处理）。diy.ui.* 由调用方 onForward 转发。
 */

import { openUrlWith } from "../core/open-url";
import type { ServerBinding } from "@diy-agent/rpc";
import { ChannelServerBinding } from "@diy-agent/rpc";
import type { EnvelopeTransport } from "@diy-agent/rpc";
import { readDrafts } from "../core/drafts";
import * as project from "../core/project";
import * as state from "../core/state";
import * as taskTree from "../core/task-tree";
import { AppConfig } from "../core/app-config";
import { refreshModelRuntime } from "../core/model-runtime";
import { hasConversation } from "../core/local-paths";
import { autoSeedEnabled, seedHome } from "../core/seed";
import { bindSeed } from "./api-domains/seed/impl";
import { bindNotice } from "./api-domains/notice/impl";
import { bindDocs } from "./api-domains/docs/impl";
import { bindJournal } from "./api-domains/journal/impl";
import { bindTemplate } from "./api-domains/template/impl";
import { bindLog } from "./api-domains/log/impl";
import { bindTool } from "./api-domains/tool/impl";
import { bindLlmConfig } from "./api-domains/llmConfig/impl";
import { bindCacheHint } from "./api-domains/cacheHint/impl";
import { bindEnv } from "./api-domains/env/impl";
import { bindKb } from "./api-domains/kb/impl";
import { bindLlmProxy } from "./api-domains/llmProxy/impl";
import { bindTraffic } from "./api-domains/traffic/impl";
import { bindFacts } from "./api-domains/facts/impl";
import { bindJob } from "./api-domains/job/impl";
import { bindProject } from "./api-domains/project/impl";
import { bindWatch } from "./api-domains/watch/impl";
import { bindHub } from "./api-domains/hub/impl";
import { bindContext } from "./api-domains/context/impl";
import { bindTask } from "./api-domains/task/impl";
import { bindRoom } from "./api-domains/room/impl";
import { splitListOption } from "./remote-discover-options";
import { bindInstances } from "./api-domains/instances/impl";
import { bindRemote } from "./api-domains/remote/impl";
import { platform, arch, release, totalmem, freemem } from "node:os";
import { currentGitBranch, findRepoRoot, homeDisplayOf, repoDisplayOf } from "../core/instance-identity";
import { readRuntimeConfig } from "../../runtime";
import * as health from "./health";
import { apiDef } from "./api-def";
import * as factsStore from "./facts-store";
import * as journalStore from "./journal-store";
import { buildDocsIndex, DEFAULT_DOCS_ROOTS } from "./docs-index";
import { TaskDetailSchema } from "../../shared/task-detail";
import { noteRendererTouch } from "./runtime-context";
import type { ToolResultMode } from "@diy-agent/compaction/compaction";
import type { HistoryEntryView } from "../../shared/context/schema";
import { readFileWindow, formatReadOutput, ReadWindowError } from "../core/file-read";
import * as flow from "../core/flow";
import { requirePostText } from "../core/flow-store";
import * as flowThread from "../core/flow-thread";
import { flowPrompt } from "./flow-prompt";
import { AsyncQueue } from "./async-queue";
import { modelNoticeHub } from "./model-notice";
import { inboxHub } from "./inbox";
import { noteWriteError } from "./env-watch";
import { setWriteErrorHook } from "../core/atomic-write";
import { collectInstances, focusInstance, renderInstanceList, selfReport } from "./instances";
import { remoteService } from "./remote";
import { hubService } from "./hub";
import { revealSelf, windowState } from "./window-ops";
import { HUMAN_MEMBER_ID, shortName } from "../../shared/room";
import { runRegistry } from "./run-registry";
import { foregroundBash } from "./foreground-bash";
import { scanOwnedProcs, groupOwnerOf, killOwnedProc } from "./process-scan";
import { procRowOf, runViewOf } from "../../shared/run-view";
import { parseEtime } from "../os";
import { stateLabel } from "../../shared/run-status";
import { fenceTaskOwner } from "../../shared/job-fence";

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

import { traffic } from "../core/traffic";
import { localISOString } from "@diy-agent/time";

const app = apiDef.diy;

/**
 * 把 Main 侧所有 diy.* handler 绑定到给定 ServerBinding（传输无关）。
 *
 * apiDef 已 router() 包裹（全名回写），binding 可以是 HttpServerBinding（生产）
 * 或 ChannelServerBinding（测试）。转发 diy.ui.* 由调用方在 binding 上 onForward。
 */

export function bindAppHandlers(binding: ServerBinding): void {
  // 写失败 → 环境通知（##384）：ENOSPC 立刻升级成 disk-full，不等下一轮轮询（30s）。
  // 挂在这里而不是 main/index.ts：Electron / serve / 测试三条入口都走 api-impl，不漏一处。
  setWriteErrorHook((e, path) => {
    void noteWriteError(e, path).catch(() => {
      /* 观测路径，绝不改变写失败语义 */
    });
  });
  // 空数据根的初始种入（lab；见 core/seed.ts）。必须在 refreshModelRuntime 之前 ——
  // 种子会写 model.yaml，晚于装配就看不见刚种下的 provider（要等下次刷新）。
  // 失败不阻断启动（种子只是便利，不是前提）。
  try {
    if (autoSeedEnabled()) {
      const r = seedHome(state.diyHome(), process.env, { autoOnly: true });
      console.log(
        r.skipped
          ? `[seed] 跳过：${r.skipped}`
          : `[seed] model=${r.model} persona=${r.persona} project=${r.project ?? "-"} tasks=${r.tasks.length}`,
      );
    }
  } catch (e) {
    console.warn("[seed] 跳过（不阻断启动）:", e);
  }

  // 装配运行时模型目录（snapshot ⊕ custom ⊕ model.yaml）。**同步**做：异步会让早期的
  // models 查询抢在装配前看到空目录。配置非法（结构错）→ 出声但不阻断启动：
  // 目录保持上一次（或空），用户仍可进界面改回来（fail-visible 而非 fail-dead）。
  try {
    const n = refreshModelRuntime(state.diyHome());
    console.log(`[model-runtime] 装配 ${n} 个模型引用`);
  } catch (e) {
    console.warn("[model-runtime] 装配失败，目录保持原状（或空）:", e);
  }

  // ── task（含 drafts 子组：未提交草稿半编辑数据，落盘且写失败必须冒泡）──
  bindTask(binding);

  // ── project ──
  bindProject(binding);

  // ── getAppStatus（供 renderer diy.ui.status 反向调用）──
  binding.on(app.getAppStatus, () => ({
    status: "ok",
    data: { pid: process.pid, uptime: process.uptime(), memory: process.memoryUsage().heapUsed },
  }));

  // ── getAppInfo（Electron / serve / CLI 三处共用，版本字段对非 Electron 环境降级）──
  binding.on(app.getAppInfo, async () => {
    const ac = new AppConfig(state.diyHome());
    const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);
    // CDP 连接地址：Electron 以 `--remote-debugging-port=0` 启动，实际端口写进
    // `userData/DevToolsActivePort`（首行端口、次行 path）—— renderer 读不到文件系统，
    // 只能由 main 侧读出来回给「复制调试信息」（口径与 CLI 的 printCdpHint 同源，见 cli/index.ts）。
    const cdp = await (async () => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      try {
        const [port, path] = readFileSync(join(ac.electronUserData, "DevToolsActivePort"), "utf-8")
          .split("\n")
          .map((x) => x.trim());
        return port && path ? `ws://127.0.0.1:${port}${path}` : "";
      } catch {
        return ""; // CDP 未启用 / serve 模式无此文件
      }
    })();
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
      cdp,
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
    // 模型目录快照：**报实际命中的绝对路径 + 来源**（##385 §3.1）——
    // 「明明刷新了为什么没生效」的第一步永远是「现在读的是哪一份」。解析失败/缺失也要出声（进 issues）。
    const { activeSnapshot } = await import("../core/models-sync");
    let models: { path: string; source: "diy-home" | "bundle" | "source-tree"; providers: number; models: number } | null = null;
    try {
      models = activeSnapshot(home)?.info ?? null;
      if (!models) {
        issues.push({
          code: "models-snapshot-missing",
          severity: "critical",
          message: "models.dev 快照不存在（候选：$DIY_HOME/data / bundle / 源树）",
          detail: `home=${home}`,
        });
      }
    } catch (e) {
      issues.push({
        code: "models-snapshot-invalid",
        severity: "critical",
        message: `models.dev 快照解析失败: ${e instanceof Error ? e.message : String(e)}`,
        detail: "跑 `diy llmConfig syncModels` 重新抓一份（失败会保留旧文件）",
      });
    }
    return {
      status: "ok",
      data: {
        pid: process.pid,
        home,
        state_exists: existsSync(join(home, "state.yaml")),
        issues: issues.map((i) => i.message),
        healthy: issues.length === 0,
        models,
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
        // agent 面状态（##355）：与任务树节点同一判据、同一真源（见 shared/task-detail.ts 注释）。
        // 草稿直接由上面读到的 `d`（readDrafts 的返回值）派生，不再二次读盘。
        has_session: hasConversation(input.uri),
        has_draft: d?.fields?.agent_input !== undefined,
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
  bindWatch(binding);

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
  binding.on(app.agent.local.chat, async function* ({ input, signal }) {
    noteRendererTouch("diy.agent.local.chat", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    const agent = getLocalAgent();
    // --mode 给出 = 入队待投递；省略 = 立即开一轮。
    if (input.mode) {
      const items = agent.steerAdd(input.taskUri, input.mode, input.message, input.author);
      // ##436 块 4：留言进信箱。这是**第二个**投递入口（房间投递是另一个，见
      // `room-service.deliverOne`）—— CLI / 别的 agent 代投的留言以前完全不进任何可读的地方，
      // 用户只会被“叫醒”却看不到内容。只记跃迁（来了一条），分级不倒这里管（归 session-alerts）。
      {
        const { messageEntryOf, noteInbox } = await import("./inbox");
        noteInbox(
          messageEntryOf({
            taskUri: input.taskUri,
            text: input.message,
            ...(input.author ? { author: input.author } : {}),
            // 以本机用户身份从 CLI / UI 发的（`--author human:chen56` 或省略即成缺省本人）⇒ N1，不给自己报信
            selfId: HUMAN_MEMBER_ID,
            ...(items[items.length - 1]?.id ? { steerId: items[items.length - 1]!.id } : {}),
          }),
        );
      }
      // ##303：入队后若**没有活跃轮次**，立刻用它开一轮 —— 留言的语义就是"发一句话"，
      // 空闲时它本就该像普通消息那样马上发出。否则没有任何机制会因它启动轮次，
      // 留言会永远躺在 .diy/drafts.yaml 里（界面只有横条，用户以为已经发出去了）。
      // 判据用 `busy()`（= chat 排队守卫的同一个 turns 注册表）：**判据与动作同源**，
      // 不忙 ⇒ 紧接着的 chatQueued 一定走"真开一轮"，不会被自己的守卫悄悄退回排队。
      if (agent.busy(input.taskUri)) return;
      try {
        for await (const op of agent.chatQueued(input.taskUri, input.model, input.reasoningEffort)) {
          yield JSON.stringify(op);
        }
      } catch (e) {
        // 竞态：判定与开轮之间别人起了轮（chat 的互斥守卫拒发）→ 留言**安好在队列里**，
        // 由那一轮的轮末带走。这里只能吞下错误：不能反手报"入队失败"（它已经入队了）。
        console.warn(`[local-agent] 空闲留言唤醒轮次失败（留言仍在队列，等待投递）${input.taskUri}:`, e);
      }
      return;
    }
    // signal：客户端断开（刷新/切页/杀 CLI）时即时退订 run.subs —— 缺了它，「无 op 产出期间断开」要
    // 等到下一条 op 才释放订阅（return() 排在悬挂的 next() 之后），`subscribers` 会虚高（[5] ##308）。
    for await (const op of agent.chat(
      input.taskUri,
      input.message,
      input.model,
      input.reasoningEffort,
      signal,
      undefined,
      // 第 23 刀：第 7 参从「author 字符串」收成 `TurnOrigin`（再扩不必加第 8 个位次）
      input.author ? { author: input.author } : undefined,
    )) {
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
    const { getLocalAgent } = await import("./local-agent");
    // 订阅者数是**运行时事实**（含 detached 与观测者接入，##305）—— 由 LocalAgentManager 算，
    // runtime-context 只管"哪些任务在跑"（纯内存表，不依赖 agent 层）。
    const agent = getLocalAgent();
    return { active: activeTurnList().map((t) => ({ ...t, subscribers: agent.watchers(t.taskUri) })) };
  });
  /**
   * 一轮的进度（**形式无关读口**；##166 第三轮口径第 2 条：给 (会话, 轮次) 返回进度块流）。
   *
   * 三份真源合成一次返回，**不新造状态**：
   *   · `turn`   —— 块流（成员会话 ops 流按 turnId 切片，走折叠缓存）
   *   · `entry`  —— 会话注册表条目（L1：steps / startedAt / state / viewers …）
   *   · `action` —— 未闭合块 ⇒「此刻在做什么」
   * 与 `room.turn` 的分工：那条是 room 便利口（按事件 id），这条是底座（不绑 room）。
   */
  binding.on(app.agent.local.turn, async ({ input }) => {
    const { getLocalAgent } = await import("./local-agent");
    const { sessionRegistry } = await import("./session-registry");
    const agent = getLocalAgent();
    return {
      taskUri: input.taskUri,
      turnId: input.turnId,
      turn: agent.turnNode(input.taskUri, input.turnId),
      live: sessionRegistry.activeTurnList().some((t) => t.uri === input.taskUri),
      entry: sessionRegistry.entryOf(input.taskUri),
      action: agent.currentAction(input.taskUri),
      now: Date.now(),
    };
  });
  binding.on(app.agent.local.history, async ({ input }) => {
    noteRendererTouch("diy.agent.local.history", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().history(input.taskUri);
  });
  // 大会话分页（任务 293）：只 fold 一段 —— 首载按预算 seek，刷新/上滚按游标取
  binding.on(app.agent.local.historyWindow, async ({ input }) => {
    noteRendererTouch("diy.agent.local.historyWindow", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().historyWindow(input.taskUri, {
      budgetBytes: input.budgetBytes,
      cursor: input.cursor,
    });
  });
  binding.on(app.agent.local.historyOlder, async ({ input }) => {
    noteRendererTouch("diy.agent.local.historyOlder", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().historyOlder(input.taskUri, {
      cursor: input.cursor,
      budgetBytes: input.budgetBytes,
    });
  });
  // 段跳（##389）：检索命中落在某一轮 ⇒ 从该轮取一段（一次到位，不走"游标→文件尾"）
  binding.on(app.agent.local.historyAt, async ({ input }) => {
    noteRendererTouch("diy.agent.local.historyAt", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().historyAt(input.taskUri, {
      at: input.at,
      budgetBytes: input.budgetBytes,
    });
  });
  // 数据层检索（##389）：扫 ops 原文 ⇒ 未渲染的轮、被压缩的历史都能命中
  binding.on(app.agent.local.find, async ({ input, signal }) => {
    noteRendererTouch("diy.agent.local.find", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().findInSession(input.taskUri, {
      query: input.query,
      scopes: { text: input.text ?? true, tool: input.tool ?? true, think: input.think ?? false },
      maxTurns: input.maxTurns,
      signal,
    });
  });
  // 会话 op 增量（##307 读侧）：水位校准起点 + 订阅写侧推送 —— UI 不再轮询、不再等轮末重放。
  // opsFeed 是 main 侧唯一写盘点的广播总线（见 services/ops-feed.ts）；CLI / 他窗口 /
  // 自愈补写的 op 同样经过它 → 任何来源的写入对所有订阅窗口即时可见。
  binding.on(app.agent.local.opsWatermark, async ({ input }) => {
    const { opsFeed } = await import("./ops-feed");
    return opsFeed.watermark(input.taskUri);
  });
  binding.on(app.agent.local.opsWatch, async function* ({ input, signal }) {
    const { opsFeed } = await import("./ops-feed");
    // signal：客户端断开（刷新/切页/杀 CLI）时即时退订。缺了它，无 op 期间断开要等到
    // 下一条 op 才释放订阅（悬挂的 next()），`agent.local.running.subscribers` 会虚高。
    for await (const frame of opsFeed.subscribe(input.taskUri, input.since, input.epoch, signal)) {
      yield frame;
    }
  });
  binding.on(app.agent.local.clear, async ({ input }) => {
    noteRendererTouch("diy.agent.local.clear", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return { cleared: getLocalAgent().clear(input.taskUri) };
  });
  // 落位迁移（##379）：**不碰会话运行时**，纯磁盘搬迁 —— 故不 noteRendererTouch（不是会话活动）。
  // 生产根只允许 dry-run（拒绝在服务端，见 services/local-layout-migrate）。
  binding.on(app.agent.local.migrateLayout, async ({ input }) => {
    const { migrateLocalLayout } = await import("./local-layout-migrate");
    return migrateLocalLayout({ dryRun: input.dryRun !== false, toolout: input.toolout });
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
  // 「立即发送」：把队列整批现在就送出去（##303 的 a 方案）。
  // 差在"现在"能到达哪里：有轮次在跑 → 全部加急到下一步；空闲 → 立刻开一轮、队列作开场白。
  // 与 chat 同为 serverStream：**只有"开了一轮"时才有 op 流**，加急分支不产 op（队列快照由 UI 自查）。
  binding.on(app.agent.local.steer.flush, async function* ({ input }) {
    noteRendererTouch("diy.agent.local.steer.flush", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    for await (const op of getLocalAgent().flushSteers(input.taskUri, input.model, input.reasoningEffort)) {
      yield JSON.stringify(op);
    }
  });
  binding.on(app.agent.local.models, async () => {
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().listModels();
  });
  binding.on(app.agent.local.limits, async () => {
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().getLimits();
  });
  // 会话/轮次注册表（##240）：一条**全局**订阅（不是 per-task）—— 快照 + delta，只推状态不推 op。
  // 不加 --watch = 只 yield 一份快照就结束（CLI 无参路径）；signal = 传输断开即退订。
  binding.on(app.agent.local.sessions, async function* ({ input, signal }) {
    const { sessionRegistry } = await import("./session-registry");
    for await (const frame of sessionRegistry.subscribe({ watch: input.watch ?? false, signal })) {
      yield frame;
    }
  });
  // 写运行限制：写盘 + 失效缓存（下一轮生效）；返回值 = 合并后的生效值（含环境变量覆盖）
  binding.on(app.agent.local.setLimits, async ({ input }) => {
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().setLimits(input);
  });
  // 逐步用量账本：结构化直出（分组/汇总在 shared/usage 的纯函数里，两端同一套口径）
  binding.on(app.agent.local.usage, async ({ input }) => {
    noteRendererTouch("diy.agent.local.usage", input.taskUri);
    const { readUsage } = await import("./usage-report");
    return readUsage(input.taskUri);
  });
  /**
   * 发送前门禁（##426 B）：量这一条消息。**只量不发** —— 超阈值由渲染层弹框，
   * 三个数（字符 / 估算 token / 成本增量 / 窗口占用）全部由这里的真源算出来。
   */
  binding.on(app.agent.local.inputGate, async ({ input }) => {
    noteRendererTouch("diy.agent.local.inputGate", input.taskUri);
    const { inputGate } = await import("../../shared/context/input-limit");
    const { loadInputLimitChars } = await import("../core/input-limit-config");
    const { diyHome } = await import("../core/state");
    const { personaForTask } = await import("../core/persona");
    const { contextLimitOf, costOf } = await import("../../shared/models");
    const { readStepUsages } = await import("./local-agent");
    const home = diyHome();
    const model = personaForTask(home, input.taskUri).model;
    // 窗口占用 = **最后一步**的总输入 + 总输出（与 turnUsagePatch.windowTotal 同口径）；
    // 没有历史步 → null（不是 0：0 会被算成"窗口空着"，那是个假事实）。
    const last = readStepUsages(input.taskUri).at(-1);
    const windowTokens = last
      ? (last.usage.inputTokens ?? 0) + (last.usage.outputTokens ?? 0)
      : null;
    const contextLimitTokens = last?.contextLimit ?? contextLimitOf(model) ?? null;
    const rates = last?.rates ?? costOf(model, 0);
    return inputGate({
      text: input.text,
      limitChars: loadInputLimitChars(home),
      contextLimitTokens,
      windowTokens,
      inputRatePerM: rates?.input ?? null,
    });
  });
  /**
   * 「转文件发送」（##426 B）：正文落 `$DIY_HOME/<taskUri>/gen/paste/<ts>.txt`，返回消息体。
   * 只落文件、不发送 —— 发送仍走原通道（两个动作各自可测、失败互不牵连）。
   */
  binding.on(app.agent.local.pasteToFile, async ({ input }) => {
    noteRendererTouch("diy.agent.local.pasteToFile", input.taskUri);
    const { isTaskUri } = await import("../../shared/task-uri");
    const { pasteFileMessage } = await import("../../shared/context/input-limit");
    const { taskDir } = await import("../core/state");
    const { writeFileAtomic } = await import("../core/atomic-write");
    const { join } = await import("node:path");
    // 断言函数必须经**显式类型的限定名**调用：TS 的 assertion signature 只认标识符 / 限定名，
    // `(await import(...)).invariant(...)` 与解构出来的裸名都不算（TS2775 / TS2776）。
    const triage: typeof import("../../shared/error-triage") = await import("../../shared/error-triage");
    triage.invariant(isTaskUri(input.taskUri), "fs/illegal-task-uri", `非法任务 URI：${input.taskUri}`);
    const stamp = localISOString().replace(/[:.]/g, "-");
    const dir = join(taskDir(input.taskUri), "gen", "paste");
    const path = join(dir, `${stamp}.txt`);
    // 原子写（##382 的唯一写原语；父目录由它 mkdir -p）。用户正文只落这一份，
    // 半截文件比没有文件更坏（模型会按残文干活）。
    writeFileAtomic(path, input.text);
    return { path, message: pasteFileMessage({ path, text: input.text }) };
  });
  // ── 压缩（compact）：少发 ≠ 销毁；历史原地保留可查、可撤销 ──
  // CLI/UI 传来的散字段 → 策略对象（缺省字段由 normalizePolicy 兜底；undefined 覆盖成默认值）
  // 散字段 → **扁平策略对象**（输入面契约；三轴形状由 normalizePolicy 统一生成，见 shared/context/compaction）
  const policyOf = (i: Record<string, unknown>): unknown => ({
    // `budgetBytes` 不再是输入面字段（##432 清理）：历史边界来自 `history.limit.limitTokens`
    // 与已落盘的 turns.jsonl，压缩策略只管工具结果的呈现方式。
    toolResult: (i.toolResult ?? i.toolOutput) as ToolResultMode | undefined,
    headtail: {
      triggerLines: i.triggerLines as number,
      headLines: i.headLines as number,
      tailLines: i.tailLines as number,
      maxLineChars: i.maxLineChars as number,
      maxKeepBytes: i.maxKeepBytes as number,
    },
    summary: i.summary as boolean | undefined,
  });
  binding.on(app.agent.local.compact.run, async ({ input }) => {
    noteRendererTouch("diy.agent.local.compact.run", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    const summary =
      input.summaryText !== undefined
        ? { text: input.summaryText, data: (input.summaryData ?? null) as never, cost: input.summaryCost ?? null }
        : undefined;
    // UI / CLI 都是**手动**：无视触发线与内容大小，至少丢一步（##442 用户 2026-10-27）
    return getLocalAgent().compact(input.taskUri, policyOf(input), "cli", summary, "manual", true);
  });
  binding.on(app.agent.local.autoCompactStatus, async ({ input }) => {
    noteRendererTouch("diy.agent.local.autoCompactStatus", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return await getLocalAgent().autoCompactStatus(input.taskUri);
  });
  binding.on(app.agent.local.autoCompactSetConfig, async ({ input }) => {
    const { saveAutoCompact, loadAutoCompact } = await import("../core/auto-compact-config");
    const { diyHome } = await import("../core/state");
    const home = diyHome();
    const cur = loadAutoCompact(home);
    // 部分更新：浅合并（triggers / policy 也是整体替换 —— 调用方给的都是完整子对象，
    // 只给一半反而会让"没提的字段"含义模糊，不如要求完整；缺子对象 = 保留现值）
    const patch = (input.patch ?? {}) as Record<string, unknown>;
    const saved = saveAutoCompact(home, { ...cur, ...patch });
    return saved;
  });
  binding.on(app.agent.local.compact.summarize, async ({ input }) => {
    noteRendererTouch("diy.agent.local.compact.summarize", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().summarize(input.taskUri);
  });
  binding.on(app.agent.local.requestView, async ({ input }) => {
    noteRendererTouch("diy.agent.local.requestView", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return await getLocalAgent().requestView(input.taskUri);
  });
  binding.on(app.agent.local.compact.preview, async ({ input }) => {
    noteRendererTouch("diy.agent.local.compact.preview", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    const txt = (input as { summaryText?: string }).summaryText;
    return await getLocalAgent().compactPreview(input.taskUri, policyOf(input), txt);
  });
  binding.on(app.agent.local.compact.ledger, async ({ input }) => {
    noteRendererTouch("diy.agent.local.compact.ledger", input.taskUri);
    const { keptRoundsView } = await import("./local-agent");
    return keptRoundsView(input.taskUri);
  });
  binding.on(app.agent.local.compact.setKept, async ({ input }) => {
    noteRendererTouch("diy.agent.local.compact.setKept", input.taskUri);
    const { getLocalAgent, keptRoundsView } = await import("./local-agent");
    const view = keptRoundsView(input.taskUri);
    const n = Math.max(0, Math.min(view.total, Math.round(input.keepRounds ?? view.total)));
    // 0 轮 = 全清：刻意**不支持**（那等于换一个会话，不是压缩）。界面把它做成禁用位置。
    if (n <= 0) return { budget: 0, applied: null, view };
    // 轮 → token 预算：把要留的那几轮的实测增量加起来（边界落到轮首，与既有判据一致）
    const kept = view.rounds.slice(view.total - n);
    const budget = Math.max(1, kept.reduce((sum, r) => sum + r.tokens, 0));
    const applied = getLocalAgent().compactToRetainTokens(input.taskUri, budget);
    return { budget, applied, view: keptRoundsView(input.taskUri) };
  });
  binding.on(app.agent.local.compact.events, async ({ input }) => {
    noteRendererTouch("diy.agent.local.compact.events", input.taskUri);
    const { getLocalAgent } = await import("./local-agent");
    return getLocalAgent().compactEvents(input.taskUri);
  });

  // 装配管道（plan）与版本链已于 ##432 清理整体删除（用户 2026-10-25 拍板：不让人/agent 编排装配计划）。

  // 会话用量报表（人读表格）：与 UI 同源同口径，只是在这里渲染成等宽文本
  binding.on(app.agent.usage, async ({ input }) => {
    const { readUsage, renderUsageSteps, renderUsageByAgent } = await import("./usage-report");
    const steps = readUsage(input.task);
    return input.byAgent
      ? renderUsageByAgent(steps, { last: input.last })
      : renderUsageSteps(steps, { last: input.last, cost: input.cost });
  });

  // ── template ──（已拆到 api-domains/template/）
  bindTemplate(binding);

  // ── context（上下文树页：**当前任务的真实上下文**，不落盘、不发 LLM）──
  bindContext(binding);

  // ── llmProxy ──（已拆到 api-domains/llmProxy/）
  bindLlmProxy(binding);

  // ── traffic（流量观测；见 core/traffic.ts）──
  // ── job 活体表（刀 8/9：run = 进程型或进程内任务；不做恢复、不做历史账）──
  bindJob(binding);

  // ── traffic（已拆到 api-domains/traffic/）
  bindTraffic(binding);

  // ── notice ──（已拆到 api-domains/notice/）
  bindNotice(binding);

  // ── env（已拆到 api-domains/env/）──
  bindEnv(binding);

  // ── cacheHint（已拆到 api-domains/cacheHint/）──
  bindCacheHint(binding);

  // ── llmConfig ──（已拆到 api-domains/llmConfig/）
  bindLlmConfig(binding);

  // ── flow（##319：工作流实例与任务绑定；状态真源 = 任务目录 flow/state.json）──
  // 「多个 k=v」型入参在 schema 里是「JSON 数组或单个裸值」（见 api-def 的 kvList 工厂）：
  // parser 只对 `z.array` 自动 JSON.parse，联合类型到这就还是字符串 → 在这里归一（唯一一处）。
  const kvList = (v: string | string[] | undefined): string[] => {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v;
    const raw = v.trim();
    if (raw.startsWith("[")) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
        throw new Error(`应为字符串数组或单个 "k=v"，实得 ${JSON.stringify(v)}`);
      }
      return parsed as string[];
    }
    return [raw];
  };

  binding.on(app.flow.list, async ({ input }) => ({
    workflows: flow.listFlowDefinitions(),
    ...(input.instances ? { instances: flow.listFlowInstances() } : {}),
  }));
  binding.on(app.flow.show, async ({ input }) => flow.showFlow(input.uri));
  binding.on(app.flow.view, async ({ input }) => flow.viewArtifact(input.uri, input.node, input.seq));
  // `--file` 的内容由**调用方进程**的 CLI parser 读好送进来（stdin / 相对路径都归它，见 _cli-meta.readFile）
  binding.on(app.flow.artifact.put, async ({ input }) => flow.putArtifact(input.uri, input.node, input.file, input.seq));
  binding.on(app.flow.start, async ({ input }) => {
    if (!input.workflow) {
      throw new Error(`缺 --workflow <id>（可用：${flow.listFlowDefinitions().map((w) => w.id).join(" / ")}）`);
    }
    return flow.startFlow(input.uri, input.workflow, kvList(input.param));
  });
  binding.on(app.flow.advance, async ({ input }) => {
    if (!input.to) throw new Error("缺 --to <节点 id>");
    return flow.advanceFlow(input.uri, input.to, kvList(input.ref), input.note);
  });
  // ##342：`--opinion` = 意见正文一等落盘（落进讨论流、挂这次打回的锚点）。
  // 锚点不用调用方传：`bounceFlow` 的回执折线末条就是这次的落点驻留（唯一标识这条打回边的穿越）。
  binding.on(app.flow.bounce, async ({ input }) => {
    if (!input.to) throw new Error("缺 --to <节点 id>");
    const author = input.author ?? "cli";
    // 空意见在**领域态变更前**就拒（否则打回落了盘、命令却报错 = 半截成功）。
    // 闸门与 discussion 写入共用一处真源（##342 review1 P2-1）。
    if (input.opinion !== undefined) requirePostText(input.opinion);
    const view = flow.bounceFlow(input.uri, input.to, kvList(input.ref), input.note, author);
    if (input.opinion !== undefined) {
      try {
        flow.appendBounceOpinion(input.uri, view, input.opinion, author);
      } catch (e) {
        // 打回（领域态）已经落盘了 —— 不假装整体失败，也不静默：说清「哪一半成了、怎么补」
        throw new Error(
          `打回已落盘（位置 ${view.position}），但意见没写进讨论流：${e instanceof Error ? e.message : String(e)}` +
            ` —— 可用 \`diy flow thread post\` 补发；删掉 ${view.files.threads} 不影响推进（讨论是旁注）`,
        );
      }
    }
    return view;
  });
  // ##342：讨论线程（只读 + 发言）。旁注坏了不外抛（`listThreads` 报 `skipped` / `error`），
  // 写侧的唯一闸门「锚点必须是真打回」在 `core/flow-thread.ts::requireRealBounce`。
  binding.on(app.flow.thread.list, async ({ input }) => flowThread.listThreads(input.uri, input.thread));
  binding.on(app.flow.thread.post, async ({ input }) =>
    flowThread.postThread(input.uri, input.thread, input.text, input.type ?? "note", input.author ?? "cli"),
  );
  binding.on(app.flow.finish, async ({ input }) => flow.finishFlow(input.uri, input.note));
  binding.on(app.flow.params.get, async ({ input }) => flow.paramsGet(input.uri));
  binding.on(app.flow.params.set, async ({ input }) => flow.paramsSet(input.uri, kvList(input.param)));
  binding.on(app.flow.prompt, async ({ input }) => flowPrompt(input.uri));
  // ##341：系统推一步（真求值 pred:/action:）—— 与上面两条「宣布」命令走的是不同那条路
  binding.on(app.flow.step, async ({ input }) => {
    const { status, to, kind, reason, view } = await flow.stepFlow(input.uri, input.cwd === undefined ? {} : { cwd: input.cwd });
    return { status, to, kind, reason, view };
  });
  // ##341 驱动环：流式（逐帧）+ **客户端断开即中断**（signal 一路传到在跑的 agent 轮次）
  binding.on(app.flow.run, async function* ({ input, signal }) {
    const { runFlow } = await import("./flow-runner");
    const queue = new AsyncQueue<unknown>();
    void runFlow(input.uri, {
      ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      signal,
      onFrame: (frame) => queue.push(frame),
    })
      .catch((e: unknown) => queue.push({ kind: "stop", reason: "turn-error", message: e instanceof Error ? e.message : String(e) }))
      .finally(() => queue.close());
    for await (const frame of queue) yield JSON.stringify(frame);
  });

  // ── docs ──（已拆到 api-domains/docs/）
  bindDocs(binding);

  // ── facts（##404：项目级事实库；agent 只经 RPC 读写，不碰 YAML）──
  // ── facts（已拆到 api-domains/facts/）
  bindFacts(binding);

  // ── journal ──（已拆到 api-domains/journal/）
  bindJournal(binding);

  // ── seed ──（已拆到 api-domains/seed/，整域自带契约 + 实现）
  bindSeed(binding);
  bindKb(binding);

  // ── log ──（已拆到 api-domains/log/）
  bindLog(binding);

  // ── room（多人房间；开发日志 ##377，设计真源 ##166 §28）──
  // room = **投递 + 汇总层**：成员各自独立会话，这里只负责"收一句话 → 投给谁 → 把回复带署名汇总回来"。
  // 投递器在 services/room-service.ts（真起一轮的是它，不是本绑定层）；落盘层在 core/room.ts。
  bindRoom(binding);

  /**
   * **邀请 = 选人物**（##166 §28.7 F ② / D 的 B 方案：影子 task）。
   *
   * 三条口径：
   *   · 面板列**人物**（不列 task）：调用方给人物 id 或名字；
   *   · backend 缺省**自动建一个专属影子 task**（复用现有一切，零内核改动）——`--task` 是高级入口；
   *   · 护栏：同一 backend 不得挂两个人物（§27 已否 A 帽子）；同一人物可进多个 room。
   */

  /**
   * 人成员的阅读游标前移（##377 第 28 刀）。
   *
   * ⚠️ 只有人成员的游标能从这里动（判据在 `core/room.markRead`）—— agent 的水位归投递 / 成轮。
   */
  /**
   * 一条 reply 的进度（##166 §28.7 A）：**不新造数据源** ——
   * 房间只存了引用（`ref = { memberUri, turnId }`），进度本身在成员会话的 ops 流里，
   * 这里把它取回来交给渲染端（与任务对话同一个块树、同一个渲染器）。
   */

  /**
   * 房间成员的**此刻状态**（L1；##166 第三轮口径第 3 条：服务端能给出，不靠 UI 猜）。
   *
   * 合成三份既有真源（不新造状态）：
   *   · 会话侧 —— `sessionRegistry.entryOf(taskUri)`（steps / startedAt / state / viewers / lastEndReason）
   *   · 进度侧 —— `local-agent.currentAction`（未闭合块 ⇒「正在 bash · rg -n …」）
   *   · room 侧 —— 投递链上的 `queued` / `running` 条数（盘上 fold 出的投递快照，无状态）
   * 纯读、无副作用；任何布局的「头像行状态」都吃这一份（详情另走 `turn`）。
   */

  // ── instances ──（已拆到 api-domains/instances/）
  bindInstances(binding);

  // ── remote ──（已拆到 api-domains/remote/）
  bindRemote(binding);

  // ── hub（配对：邀请码 + Owner 审批 + Token 长连；##500）──
  // 协议真源 docs/plans/2026-11-01-hub-pairing.md：地址即身份（人比对真实 URL），码只管「谁被允许进来」。
  // ⚠️ 卫星侧 `join` 分两步：不带 code 只显示地址；带 code 才发秘密（判据 6/7）。
  bindHub(binding);

  // ── tool ──（已拆到 api-domains/tool/）
  bindTool(binding);

}

/** 兼容旧用法：把 Main 侧 handlers 绑到某 transport 的 ChannelServerBinding（如 IPC） */
export function bindApi(transport: EnvelopeTransport): ServerBinding {
  const binding = new ChannelServerBinding(transport);
  bindAppHandlers(binding);
  return binding;
}

/**
 * CLI 的「一串值」选项：`--sources local,mdns` 与 `--sources '["local","mdns"]'` 都收。
 * 空值 / 空串 → undefined（= 用缺省），别把 [] 当成「一路都不跑」。
 */

