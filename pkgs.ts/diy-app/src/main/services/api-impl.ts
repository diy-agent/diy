/**
 * api-impl.ts — Main 进程 RPC handler 绑定（handle 分离）
 *
 * 从 api-def.ts 导入纯 meta，通过 binding.on(meta, handler) 逐个绑定实现。
 * 业务逻辑在这里，schema 定义在 api-def.ts。
 * 命名体系：diy.*（Main 进程域，本地处理）。diy.ui.* 由调用方 onForward 转发。
 */

import type { ServerBinding } from "@diy-agent/rpc";
import { ChannelServerBinding } from "@diy-agent/rpc";
import type { EnvelopeTransport } from "@diy-agent/rpc";
import * as task from "../core/task";
import { DRAFT_FIELDS, clearDrafts, readDrafts, writeDrafts, type DraftField } from "../core/drafts";
import * as project from "../core/project";
import * as state from "../core/state";
import * as taskTree from "../core/task-tree";
import { AppConfig } from "../core/app-config";
import { refreshModelRuntime } from "../core/model-runtime";
import { hasConversation } from "../core/local-paths";
import { autoSeedEnabled, seedHome } from "../core/seed";
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
import type { ToolResultMode } from "@diy/compact/compaction";
import type { HistoryEntryView } from "../../shared/context/schema";
import { readFileWindow, formatReadOutput, ReadWindowError } from "../core/file-read";
import { resolve as resolvePath, relative as relativePath, isAbsolute as isAbsolutePath } from "node:path";
import * as flow from "../core/flow";
import { requirePostText } from "../core/flow-store";
import * as flowThread from "../core/flow-thread";
import { flowPrompt } from "./flow-prompt";
import { AsyncQueue } from "./async-queue";
import { modelNoticeHub } from "./model-notice";
import { inboxHub } from "./inbox";
import { envWatchHub, ensureDiskPoller, noteWriteError, realStatfs, simulateEnvFact } from "./env-watch";
import { envNoticeFromDisk, fmtDiskBytes, type EnvNotice } from "../../shared/env-watch";
import { setWriteErrorHook } from "../core/atomic-write";
import { collectInstances, focusInstance, renderInstanceList, selfReport } from "./instances";
import { revealSelf, windowState } from "./window-ops";
import { HUMAN_MEMBER_ID, shortName } from "../../shared/room";
import { runRegistry } from "./run-registry";
import { foregroundBash } from "./foreground-bash";
import { scanOwnedProcs, groupOwnerOf, killOwnedProc } from "./process-scan";
import { procRowOf, runViewOf } from "../../shared/run-view";
import { parseEtime } from "./process-sampler";
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

const app = apiDef.diy;

/**
 * 把 Main 侧所有 diy.* handler 绑定到给定 ServerBinding（传输无关）。
 *
 * apiDef 已 router() 包裹（全名回写），binding 可以是 HttpServerBinding（生产）
 * 或 ChannelServerBinding（测试）。转发 diy.ui.* 由调用方在 binding 上 onForward。
 */
/**
 * `diy env ls` 的人读表格（对齐 instances.ls 的口径：给人看，不是给程序解析）。
 *
 * 数字**一律给**（`rule`：更明确的识别 = 给数字，不是给形容词）：只写"磁盘可能满了"
 * 对排查没有价值。
 */
function renderEnvList(rows: EnvNotice[]): string {
  if (rows.length === 0) return "环境正常：磁盘水位充足、网络无连续失败。";
  const lines = rows.map((n) => {
    switch (n.type) {
      case "disk-full":
      case "disk-low": {
        const d = n.data;
        const size =
          d.availBytes < 0 || d.totalBytes < 0
            ? "可用空间读不到"
            : `可用 ${fmtDiskBytes(d.availBytes)} / 共 ${fmtDiskBytes(d.totalBytes)}`;
        const from = d.source === "write-error" ? "（写失败被动升级）" : "（轮询）";
        return `[${n.level}] ${n.type}  ${d.mount || "?"}  ${size}${from}  ${d.reason}  (id=${n.id})`;
      }
      case "network-down": {
        const d = n.data;
        return `[${n.level}] ${n.type}  连续 ${d.streak} 次${d.code ? ` ${d.code}` : ""}  ${d.message}  ${d.reason}  (id=${n.id})`;
      }
    }
  });
  return lines.join("\n");
}

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

  // ── task ──
  /**
   * 找 **cwd 属于哪个项目**（##430）。
   *
   * 多个项目可以**互相嵌套**（实测数据根里同时注册了 `~/git/diy` 与 `~/git/diy/diy`），
   * 所以「包含 cwd」的项目可能不止一个 —— 取**最深的那个**（路径最长）作为语义归属：
   * 人在 `~/git/diy/diy`（或其 worktree）里敲命令，归属就是代码仓本身，不是它的父目录。
   */
  function projectOwningCwd(cwd: string): { id: string; path: string; label?: string } | undefined {
    const target = resolvePath(cwd);
    let best: { id: string; path: string; label?: string } | undefined;
    for (const { id, info } of project.listProjects()) {
      const root = project.getProjectPath(id);
      if (!root) continue;
      const rel = relativePath(root, target);
      // rel === "" → 就在项目根；不以 .. 开头且非绝对 → 在其子目录（worktree 天然成立）
      if (rel !== "" && (rel.startsWith("..") || isAbsolutePath(rel))) continue;
      if (!best || root.length > best.path.length) best = { id, path: root, label: info.label };
    }
    return best;
  }

  binding.on(app.task.create, async ({ input }) => {
    // 正文输入的显式三态（##338 / ##376）：`body|bodyText|bodyFile` 三选一 —— 与 `task edit`
    // 同一裁决点（core/task.ts::resolveBodyOverride），免得"某条命令漏了护栏"再次发生。
    // `cwd` / `force` 不是任务字段：cwd 由 CLI parser 自动注入（归属检测用），force 是逃生口。
    const { body, bodyText, bodyFile, cwd, force, ...rest } = input;

    // 归属检测（##430）：人在某个项目的目录里（或其 worktree 里），却给**另一个** project ——
    // 实际踩过：在 `~/git/diy/diy` 的 worktree 里把 ##92/93/94 建到了父目录项目 2，
    // 两个项目各自有 tasks/92，同号撞车，事后靠两轮对话才纠正。
    // 口径：**只拒绝、不猜**（猜错比报错贵）。要给别的项目建任务 → 显式换 --project，或加 --force。
    if (!force && cwd) {
      const owner = projectOwningCwd(cwd);
      if (owner && owner.id !== rest.project) {
        const cand = project
          .listProjects()
          .map(({ id, info }) => `  ${id} · ${info.label ?? "(无 label)"} · ${info.path ?? "(无 path)"}`)
          .join("\n");
        throw new task.ValidationError([
          {
            field: "project",
            code: "project-mismatch",
            msg:
              `cwd 属于 project ${owner.id}（${owner.label ?? "无 label"} · ${owner.path}），` +
              `但给的是 project ${rest.project} —— 层号/路径不符，拒绝创建（免得多项目同号任务撞车）。\n` +
              `候选项目：\n${cand}\n` +
              `下一步：把 project 改成 ${owner.id}；确要在 ${rest.project} 下建则加 --force。`,
          },
        ]);
      }
    }

    const resolvedBody = task.resolveBodyOverride({ body, bodyText, bodyFile });
    const uri = task.createTask({ ...rest, body: resolvedBody } as any);
    // 归属回显（##430）：只回 uri 时人看不出落到了哪个仓，故带上 label / path
    const info = project.getProjectInfo(rest.project);
    return { status: "ok", data: { uri, project: rest.project, label: info?.label, path: info?.path } };
  });
  binding.on(app.task.list, async ({ input }) => {
    const tasks = task.listTasks(input.project);
    // 多项目同号可分辨（##430）：`tasks` 仍是 uri 字符串数组（形状不变），
    // 归属另给一张 id → label/path 的表 —— 只有 id 时 `projects/2/tasks/92` 与
    // `projects/4/tasks/92` 脱离上下文看不出是哪个仓。
    const ids = new Set(tasks.map((u) => u.split("/")[1]));
    const projects = project
      .listProjects()
      .filter(({ id }) => ids.has(id))
      .map(({ id, info }) => ({ id, label: info.label, path: info.path }));
    return { status: "ok", data: { tasks, projects } };
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
    // 正文输入的显式三态（##338）：`body|bodyText|bodyFile`、`appendBody|appendBodyFile|appendBodyText`
    // 各自三选一 —— 求值收敛在 core（`resolveBodyInputs`），此处只负责把这两组从普通字段里摘出来。
    const { uri, body, bodyText, bodyFile, appendBody, appendBodyFile, appendBodyText, ...changes } = input;
    const bodyInputs = task.resolveBodyInputs({ body, bodyText, bodyFile, appendBody, appendBodyFile, appendBodyText });
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v !== undefined) filtered[k] = v as string;
    }
    // 回报本次写入实际做了什么（剥头 / 追加）—— CLI 侧才有话可说，见 core/task.ts 的 TaskWriteReport
    const report = task.updateTask(uri, { ...filtered, ...bodyInputs } as task.UpdateTaskChanges);
    return { status: "ok", data: { uri, ...report } };
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
    const { uri, base_updated, body, bodyText, bodyFile, ...rest } = input;
    const fields: Partial<Record<DraftField, string>> = {};
    for (const f of DRAFT_FIELDS) {
      const v = (rest as Record<string, string | undefined>)[f];
      if (v !== undefined) fields[f] = v;
    }
    // 正文草稿的显式三态（##376）：`--body` / `--body-text` / `--body-file` 三选一，
    // 与 `task edit` 同一裁决点；三态都未给 = 不动该字段（与其它字段的"不传=保持"一致）。
    const bodyDraft = task.resolveBodyOverride({ body, bodyText, bodyFile });
    if (bodyDraft !== undefined) fields.body = bodyDraft;
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
  binding.on(app.watch.fileChange, async function* ({ signal }) {
    const { fileWatcher } = await import("./file-watcher");
    for await (const change of fileWatcher.subscribe(signal)) {
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
    const { loadInputLimitChars } = await import("../core/context-config");
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
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
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
    const { defaultSystemPlaces } = await import("@diy/context/delivery");
    const { existsSync } = await import("node:fs");
    const { diyHome } = await import("../core/state");
    const { loadInputLimitChars } = await import("../core/context-config");
    return {
      systemPlaces: loadSystemPlaces(diyHome()),
      defaults: defaultSystemPlaces(),
      fromFile: existsSync(contextConfigFile(diyHome())),
      inputLimitChars: loadInputLimitChars(diyHome()),
    };
  });
  binding.on(app.context.setConfig, async ({ input }) => {
    const { saveInputLimitChars, saveSystemPlaces } = await import("../core/context-config");
    const { diyHome } = await import("../core/state");
    const home = diyHome();
    const systemPlaces = saveSystemPlaces(home, input.systemPlaces);
    // inputLimitChars 缺省不改（undefined = 只改划分）；给了才写
    const inputLimitChars =
      input.inputLimitChars === undefined ? undefined : saveInputLimitChars(home, input.inputLimitChars);
    return { systemPlaces, inputLimitChars: inputLimitChars ?? null };
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
      const { previewSimulatedRequest } = await import("./local-agent");
      const { getModelCatalog } = await import("../../shared/models");
      // 无缺省模型：预演不指定就用目录首项（目录空 = 无 provider，model 为空 → 预演只组装不发）
      const model = input.model || getModelCatalog()[0]?.ref || "";
      const sim = await previewSimulatedRequest({
        taskUri,
        // system 里已含 help / system / runtime 三份全量（##442 用户 2026-10-27 口径），
        // runtime 不再单独进尾部 user 消息。
        system: lab.system.text,
        model,
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
    const { summarizeStats, dropBaselineChanges } = await import("../../shared/context/stats");
    const { projectDir, projectFromUri } = await import("../core/state");
    // project 以 taskUri 为准（与 lab/diff 同一口径：两者不一致时只有 CLI 能造成）
    const project = input.taskUri ? projectFromUri(input.taskUri) || input.project : input.project;
    // 首轮基线不算变化：老文件（写入器修前）每任务首轮把全部 path 记成变化 → 在这里抹平。
    // 必须在 filter/slice **之前**（切完片最早那条已不是首轮，无从分辨）—— review RV-15。
    let records = dropBaselineChanges(readContextStats(projectDir(project)));
    if (input.taskUri) records = records.filter((r) => r.taskUri === input.taskUri);
    const total = records.length;
    if (input.limit && input.limit > 0) records = records.slice(-input.limit);
    return { ...summarizeStats(records), records: total };
  });

  binding.on(app.context.changelog, async ({ input }) => {
    const { readCtxLog } = await import("../core/context-changelog");
    const { isV2Entry, entryToRows, foldCtxLog, opsFromHashes } = await import("../../shared/context/changelog");
    const { readDeliverySteps, readStepUsages } = await import("./local-agent");
    const { groupByTurn } = await import("../../shared/usage");
    const steps = readDeliverySteps(input.taskUri);
    // 每条 ref 的徽章：投递快照（划分 + 两份容器是否变）与用量账本（缓存率 + 金额）都按 turnId join。
    // 都**可能不可得**（快照被清、老账本没字段）→ 给 null，UI 不画徽章，不谎报"没变"。
    const stepIdx = new Map(steps.map((s, i) => [s.turnId, i]));
    const usage = new Map(groupByTurn(readStepUsages(input.taskUri)).map((g) => [g.turnId, g]));
    const badges = (turnId: string) => {
      const i = stepIdx.get(turnId);
      const cur = i === undefined ? undefined : steps[i];
      const prev = i !== undefined && i > 0 ? steps[i - 1] : undefined;
      const buckets = usage.get(turnId)?.buckets;
      return {
        turnIndex: i === undefined ? null : i + 1,
        systemPlaces: cur?.systemPlaces ?? [],
        systemDiffers: cur && prev ? cur.systemText !== prev.systemText : null,
        runtimeDiffers: cur && prev ? cur.runtimeText !== prev.runtimeText : null,
        // 注记段缺字段（老快照）= 不知道 ⇒ null（UI 不画徽章），别拿 undefined 跟字符串比得「变了」
        historyDiffers: cur?.historyText === undefined || prev?.historyText === undefined ? null : cur.historyText !== prev.historyText,
        incomparable: cur && prev ? cur.wireVersion !== prev.wireVersion : null,
        cacheHitRate: buckets && buckets.inputTotal > 0 ? buckets.cacheRead / buckets.inputTotal : null,
        cost: usage.get(turnId)?.cost ? usage.get(turnId)!.cost!.total : null,
      };
    };

    const raw = readCtxLog(input.taskUri);
    const v2 = raw.filter(isV2Entry);
    const entries: HistoryEntryView[] = [];
    let source: "log" | "derived" = "log";
    if (v2.length > 0) {
      // 二版：before/after 自带 → 直接可渲染（不再回放）
      for (const e of v2) {
        entries.push({
          seq: e.seq,
          type: e.type,
          ts: e.ts,
          model: e.model,
          wireVersion: e.wireVersion,
          ref: e.ref,
          changes: entryToRows(e),
          ...badges(e.ref.turnId),
        });
      }
    } else {
      // 降级：老格式日志（一版回放）或纯折算（从投递快照的值 hash 差还原；无值预览）
      const legacy = raw.filter((r) => !isV2Entry(r));
      source = legacy.length > 0 ? "log" : "derived";
      const records =
        legacy.length > 0
          ? (legacy as unknown as Parameters<typeof foldCtxLog>[0])
          : steps.map((s, i) => ({
              ts: s.ts,
              turnId: s.turnId,
              model: s.model,
              wireVersion: s.wireVersion,
              ops: opsFromHashes(i === 0 ? null : steps[i - 1]!.valueHashes, s.valueHashes),
            }));
      for (const t of foldCtxLog(records)) {
        entries.push({
          seq: t.index - 1,
          type: t.baseline ? "baseline" : "changed",
          ts: t.ts,
          model: t.model,
          wireVersion: t.wireVersion,
          ref: { turnId: t.turnId, stepId: t.turnId, step: t.index },
          changes: t.changes,
          ...badges(t.turnId),
        });
      }
    }
    // **只要变化**：降级路径（老格式日志回放 / 从投递快照折算）会**每步**给一条 —— 没变的那步
    // 落在时间线上就是一个空行，实测老任务里能占掉一多半（用户 2026-10-22：「变化步骤很多是空
    // 步骤，只需要变化的步骤才记录和显示」）。v2 记录本身"有变才写"，这里的过滤对它无副作用，
    // 对降级路径是**显示侧的兜底**（记录侧无从修：那些步的日志已经写死了）。
    // baseline 不在过滤之列 —— 它是时间线的起点，不是"某一步的变化"。
    const kept = entries.filter((e) => e.type === 'baseline' || e.changes.length > 0);
    const total = kept.length;
    return {
      total,
      source,
      entries: input.limit && input.limit > 0 ? kept.slice(-input.limit) : kept,
    };
  });

  binding.on(app.context.rebaseline, async ({ input }) => {
    const { getLocalAgent } = await import("./local-agent");
    getLocalAgent().markRebaseline(input.taskUri);
    return {
      ok: true,
      message:
        "已置位：该任务下一次真发时落一条新 baseline（起点）。" +
        "（轮次中途置位则下一轮生效 —— 起点只能在轮首写）",
    };
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
        historyDiffers: d?.historyDiffers ?? false,
        systemDiff: d?.systemDiff ?? [],
        runtimeDiff: d?.runtimeDiff ?? [],
        historyDiff: d?.historyDiff ?? [],
        systemText: cur.systemText,
        runtimeText: cur.runtimeText,
        historyText: cur.historyText ?? "",
        baseSystemText: prev?.systemText ?? null,
        baseRuntimeText: prev?.runtimeText ?? null,
        baseHistoryText: prev?.historyText ?? null,
      };
    }
    // 未选中：**当前变量树** vs 最后一步（"我现在改的东西会带来什么变化"）
    const { assembleGlobals } = await import("./prompt-registry");
    const { diyHome, projectFromUri } = await import("../core/state");
    const { buildDelivery } = await import("@diy/context/delivery");
    const { loadSystemPlaces } = await import("../core/context-config");
    const project = projectFromUri(input.taskUri) || input.project;
    // 房间上下文（##377 第 26 刀）：预览与真发同一份装配（取**本任务自己的房间**）
    const { roomRuntimeFact } = await import("./room-context");
    const roomCtx = (await roomRuntimeFact({ roomId: input.taskUri, taskUri: input.taskUri }))?.value ?? null;
    const globals = assembleGlobals(diyHome(), project, {
      taskUri: input.taskUri,
      room: roomCtx,
    }) as unknown as Record<string, unknown>;
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
      // live 模式比的是「当前变量树 vs 最后一步」：注记段**不属于变量树**（它由压缩选择算），
      // 当前没有"待发的注记"⇒ 不存在可比对象，恒 false；历史行对照仍给 baseHistoryText。
      historyDiffers: false,
      systemDiff: d.systemDiff,
      runtimeDiff: d.runtimeDiff,
      historyDiff: d.historyDiff,
      systemText: now.system.text,
      runtimeText: now.runtime.text,
      historyText: "",
      baseSystemText: last.systemText,
      baseRuntimeText: last.runtimeText,
      baseHistoryText: last.historyText ?? null,
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

  // ── traffic（流量观测；见 core/traffic.ts）──
  // ── job 活体表（刀 8/9：run = 进程型或进程内任务；不做恢复、不做历史账）──
  binding.on(app.job.ps, async ({ input }) => {
    const now = Date.now();
    const all = runRegistry.list();
    const picked = input.all === true ? all : all.filter((r) => r.state === "running");
    // 顺带扫一遍 ps：登记过的 run 之外，命令里自己 `nohup xxx &` 起的进程也要看见（##408 刀 10）。
    // `scan:false` 只给"我只要表里那几条"的调用方（省一次 ps）。
    // 缺省**扫**；`--no-scan` 才跳过。为什么不是 `scan: boolean`：
    // CLI 的布尔选项缺省是 `false`（`--scan` 不写就是 false），会把"没表态"读成"不要扫"
    // —— 实测症状：`diy job ps` 永远 `scanOk:false`、看不见 `nohup xxx &` 起的孤儿。
    const scan = input.noScan === true ? null : await scanOwnedProcs({ runPids: runRegistry.pidMap() });
    const procRows = (scan?.procs ?? []).map((p) =>
        procRowOf(p, parseEtime(p.etimeText), groupOwnerOf(p.pgid)),
    );
    const byRun: Record<string, typeof procRows> = {};
    for (const row of procRows) if (row.runId) (byRun[row.runId] ??= []).push(row);
    return {
      status: "ok",
      data: {
        runs: await Promise.all(
            picked.map(async (r) => runViewOf(r, now, (await runRegistry.outputBytes(r.id)) ?? null)),
        ),
        /** 没登记进活体表的进程（表格里跟在 run 后面） */
        untracked: procRows.filter((r) => r.runId === null),
        /** 每条 run 名下的进程（含根进程；根进程退了但子孙还在时这里仍非空） */
        procsByRun: byRun,
        running: all.filter((r) => r.state === "running").length,
        total: all.length,
        scanAt: scan?.at ?? null,
        scanOk: scan?.ok ?? false,
      },
    };
  });
  binding.on(app.job.detachables, async ({ input }) => ({
    status: "ok",
    data: { items: foregroundBash.list(input.taskUri) },
  }));
  binding.on(app.job.detach, async ({ input }) => {
    try {
      const info = await foregroundBash.detach(input.toolCallId, input.taskUri);
      return { status: "ok", data: { id: info.id, pid: info.pid ?? null, logPath: info.logPath } };
    } catch (err) {
      // 拒绝是**正常时序**（恰好结束 / 连按两次 / 跨任务）—— 如实回给调用方，不抛
      const code = (err as { code?: unknown }).code;
      return { status: "error", msg: `${typeof code === "string" ? `[${code}] ` : ""}${(err as Error).message}` };
    }
  });
  binding.on(app.job.procs, async () => {
    const scan = await scanOwnedProcs({ runPids: runRegistry.pidMap() });
    return {
      status: "ok",
      data: {
        at: scan.at,
        ok: scan.ok,
        procs: scan.procs.map((p) => procRowOf(p, parseEtime(p.etimeText), groupOwnerOf(p.pgid))),
      },
    };
  });
  binding.on(app.job.killproc, async ({ input }) => {
    // 重新扫一遍再动手：pid 可能已被回收、也可能根本不是我们的（调用方给错号的代价是杀别人）
    const scan = await scanOwnedProcs({ runPids: runRegistry.pidMap() });
    const hit = scan.procs.find((p) => p.pid === input.pid);
    if (!hit) {
      return { status: "error", msg: `pid ${input.pid} 不在"归我们管"的进程名单里（diy job procs 看现在有哪些）` };
    }
    // 归属闸（`shared/job-fence.ts`）：声明必须与我们记下的归属一致。
    // 组名册是首选（野进程只有它有记录）；登记过的 run 再退到它的 origin。
    const owner = groupOwnerOf(hit.pgid)?.taskUri ?? (hit.runId ? runRegistry.get(hit.runId)?.origin?.taskUri : undefined);
    const fence = fenceTaskOwner(input.taskUri, owner ?? null, `进程 ${hit.pid}`);
    if (!fence.ok) return { status: "error", msg: fence.msg };
    const ok = killOwnedProc(hit, scan.selfPgid);
    return { status: "ok", data: { ok, pid: hit.pid, pgid: hit.pgid } };
  });
  binding.on(app.job.kill, async ({ input }) => {
    const info = runRegistry.get(input.id);
    if (!info) return { status: "error", msg: `没有这条 run：${input.id}（diy job ps 看在跑什么）` };
    if (info.state !== "running") return { status: "error", msg: `这条 run 已经结束（${stateLabel(info.state)}），无需停止` };
    const fence = fenceTaskOwner(input.taskUri, info.origin?.taskUri ?? null, `run ${input.id}`);
    if (!fence.ok) return { status: "error", msg: fence.msg };
    const ok = runRegistry.kill(input.id);
    return { status: "ok", data: { ok, id: input.id } };
  });
  binding.on(app.job.tail, async ({ input }) => {
    const tail = await runRegistry.tail(input.id, input.lines ?? 40);
    if (!tail) return { status: "error", msg: `没有这条 run：${input.id}` };
    return { status: "ok", data: { ...tail, logPath: runRegistry.get(input.id)?.logPath ?? null } };
  });
  binding.on(app.job.meta, async ({ input }) => {
    const info = runRegistry.get(input.id);
    if (!info) return { status: "error", msg: `没有这条 run：${input.id}` };
    return {
      status: "ok",
      data: {
        metaJson: (await runRegistry.metaJson(input.id)) ?? null,
        dir: info.dir,
        logPath: info.logPath,
        outputBytes: (await runRegistry.outputBytes(input.id)) ?? null,
      },
    };
  });

  binding.on(app.traffic.snapshot, async ({ input }) => traffic.snapshot(input.withRecords ?? true));
  binding.on(app.traffic.clear, async () => {
    traffic.clear();
    return { status: "ok" };
  });
  binding.on(app.traffic.setFullCapture, async ({ input }) => {
    traffic.setFullCapture(input.on);
    return traffic.snapshot();
  });
  binding.on(app.traffic.setCap, async ({ input }) => {
    traffic.setCap(input.n);
    return traffic.snapshot();
  });
  binding.on(app.traffic.readLog, async ({ input }) => {
    try {
      const record = traffic.readLog({ file: input.file, offset: input.offset, len: input.len });
      return { ok: true, message: null, record };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), record: null };
    }
  });
  binding.on(app.traffic.query, async ({ input }) => traffic.query(input));
  binding.on(app.traffic.logFiles, async () => ({
    dir: traffic.logDir(),
    files: traffic.listLogFiles(),
    dates: traffic.listLogDates(),
    bytes: traffic.logStats().bytes,
    detail: traffic.listLogFileDetail(),
  }));
  binding.on(app.traffic.cleanLogs, async ({ input }) => traffic.cleanLogs(input));
  binding.on(app.traffic.revealLog, async ({ input }) => {
    const abs = traffic.absLogFile(input.file);
    try {
      // Electron 主进程才有 shell；web/serve 模式下拿不到 → 给人话提示
      const { shell } = await import("electron");
      shell.showItemInFolder(abs);
      return { ok: true, message: null };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), };
    }
  });
  binding.on(app.traffic.events, async function* () {
    for await (const ev of traffic.events()) yield ev;
  });

  // ── notice（「模型不可用」通知；##369 ①）──
  // 数据源是 main 侧通知中心（真发失败的 catch 里 push）：renderer 只订阅/关闭，不产生。
  binding.on(app.notice.list, async () => modelNoticeHub.list());
  binding.on(app.notice.dismiss, async ({ input }) => {
    modelNoticeHub.dismiss(input.id);
    return { status: "ok" };
  });
  binding.on(app.notice.watch, async function* ({ signal }) {
    for await (const n of modelNoticeHub.subscribe(signal)) yield n;
  });

  // ── inbox（N1 提示的落盘流水；##429 要求 ④/⑤）──
  // 与 notice / env 两个内存 ring 不同：这里是 append-only 落盘（重启后仍可回看）。
  binding.on(app.notice.inbox.list, async ({ input }) => inboxHub.list({ taskUri: input.taskUri, limit: input.limit }));
  binding.on(app.notice.inbox.watch, async function* ({ signal }) {
    for await (const e of inboxHub.subscribe(signal)) yield e;
  });

  // ── env（「环境感知」通知；##384）──
  // 数据源 = main 侧环境通知中心（主动轮询磁盘水位 + 被动写失败/网络错误码）。
  // 首次访问顺手起轮询器（懒加载：Electron / serve / 测试三条入口都走 api-impl，不漏一处）。
  binding.on(app.env.list, async () => {
    ensureDiskPoller();
    return envWatchHub.list();
  });
  binding.on(app.env.ls, async () => {
    ensureDiskPoller();
    return renderEnvList(envWatchHub.list());
  });
  binding.on(app.env.dismiss, async ({ input }) => {
    envWatchHub.dismiss(input.id);
    return { status: "ok" };
  });
  binding.on(app.env.watch, async function* ({ signal }) {
    ensureDiskPoller();
    for await (const ev of envWatchHub.subscribe(signal)) yield ev;
  });
  binding.on(app.env.simulate, async ({ input }) => {
    if (readRuntimeConfig().env === "production") {
      throw new Error("env simulate 是探针命令，生产环境一律拒绝（DIY_ENV=production）");
    }
    if (input.diskAvail !== undefined) {
      const notice = await simulateEnvFact({
        kind: "disk",
        availBytes: input.diskAvail,
        totalBytes: input.diskTotal ?? 500 * 1024 ** 3,
        mount: input.diskMount,
      });
      return { notice };
    }
    if (input.netCode !== undefined) {
      const notice = await simulateEnvFact({
        kind: "network",
        code: input.netCode,
        streak: input.netStreak,
        message: input.netMessage,
      });
      return { notice };
    }
    throw new Error("至少给一个事实：--disk-avail <bytes> 或 --net-code <code>");
  });
  binding.on(app.env.probe, async ({ input }) => {
    const target = input.path ?? process.env["DIY_ENV_WATCH_TARGET"] ?? "/";
    const sample = await realStatfs(target);
    const notice = envNoticeFromDisk(sample, "poll");
    if (notice) envWatchHub.push(notice);
    else envWatchHub.resolveDisk(sample);
    return { sample, notice };
  });

  // ── llmConfig（模型 provider 配置）──
  binding.on(app.llmConfig.read, async () => {
    const { registryView } = await import("../core/model-registry");
    try {
      return registryView(state.diyHome());
    } catch (e) {
      // 配置坏文件（结构非法）不该让 UI 锁死：返回空视图 + error，页面仍能打开提示（##275 R1-6）
      return {
        modelFile: { stdProviders: {}, customProviders: {} },
        customSpecs: {},
        catalog: [],
        providers: [],
        calendars: [],
        windows: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
  binding.on(app.llmConfig.write, async ({ input }) => {
    const { saveModelConfig } = await import("../core/model-config");
    saveModelConfig(state.diyHome(), input.modelFile);
    refreshModelRuntime(state.diyHome());
    return { status: "ok" };
  });
  binding.on(app.llmConfig.writeSpec, async ({ input }) => {
    const { loadCustomSpecs, saveCustomSpecs } = await import("../core/model-config");
    const specs = loadCustomSpecs(state.diyHome());
    if (input.spec === null) delete specs[input.id];
    else specs[input.id] = input.spec;
    saveCustomSpecs(state.diyHome(), specs);
    refreshModelRuntime(state.diyHome());
    return { status: "ok" };
  });

  /**
   * 模型目录刷新（##385）：手工按钮（模型页 / 模型不可用 bar）入口。
   * 与定时任务共用 `refreshAndApply` —— 写盘 + 让进程内快照缓存失效 + 重装运行时目录。
   * **不抛**：失败进返回值（ok=false + error），UI 直接渲染三态。
   */
  binding.on(app.llmConfig.syncModels, async () => {
    const { refreshAndApply } = await import("../core/models-sync");
    return refreshAndApply({ home: state.diyHome() });
  });

  binding.on(app.llmConfig.costs, async ({ input }) => {
    const { providerCosts } = await import("../core/llm-cost");
    return providerCosts(state.diyHome(), input.provider);
  });
  // 价目写入后立刻重装运行时目录（与 write / writeSpec 同一处收敛）：改价即生效，
  // 不必等下次 provider 配置改动才被读到。
  binding.on(app.llmConfig.setCost, async ({ input }) => {
    const { setModelCost } = await import("../core/llm-cost");
    const result = setModelCost(state.diyHome(), input);
    refreshModelRuntime(state.diyHome());
    return result;
  });
  binding.on(app.llmConfig.setTiers, async ({ input }) => {
    const { setModelTiers } = await import("../core/llm-cost");
    const result = setModelTiers(state.diyHome(), input);
    refreshModelRuntime(state.diyHome());
    return result;
  });
  binding.on(app.llmConfig.scanEnv, async () => {
    const { scanEnv } = await import("../core/model-import");
    // 连同扫描面（provider 数 / 变量名）一起回报：零命中时 UI 要能说清「查过什么」
    return scanEnv(state.diyHome());
  });
  binding.on(app.llmConfig.importEnv, async ({ input }) => {
    const { importEnvProviders } = await import("../core/model-import");
    const r = importEnvProviders(state.diyHome(), input.providers);
    // 落盘后立即重装运行时目录（与 write/writeSpec 同一约定：改配置即刻生效）
    if (r.imported.length > 0) refreshModelRuntime(state.diyHome());
    return r;
  });

  binding.on(app.llmConfig.probe, async ({ input }) => {
    // 拉 `${baseUrl}/models`：既是连通性测试，也是 custom provider 的模型清单来源。
    // 不强求成功：上游若不支持 /models（如 commandcode），ok=false 且 error 说明原因。
    const { expandEnvValue } = await import("../core/model-registry");
    if (input.apiKey.trim() === "") return { ok: false, status: null, models: [], error: "账号密钥为空" };
    const expanded = expandEnvValue(input.apiKey);
    if (expanded.error || expanded.value === null) {
      return { ok: false, status: null, models: [], error: expanded.error ?? "密钥为空" };
    }
    const base = input.baseUrl.replace(/\/+$/, "");
    traffic.noteProbe(base); // 让流量页能标注「模型配置探测」来源
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(`${base}/models`, {
        headers: expanded.value ? { authorization: `Bearer ${expanded.value}` } : {},
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, models: [], error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      let models: { id: string; name: string | null; context: number | null; endpoints: string[] }[] = [];
      try {
        const json = JSON.parse(text) as {
          data?: Array<{ id?: string; name?: string; context_length?: number; supported_endpoints?: string[] }>;
        };
        models = (json.data ?? [])
          .filter((m) => typeof m?.id === "string")
          .map((m) => ({
            id: m.id as string,
            name: m.name ?? null,
            context: typeof m.context_length === "number" ? m.context_length : null,
            endpoints: Array.isArray(m.supported_endpoints) ? m.supported_endpoints.filter((e) => typeof e === "string") : [],
          }));
      } catch {
        return { ok: false, status: res.status, models: [], error: "响应不是 JSON（/models 不可解析）" };
      }
      return { ok: true, status: res.status, models, error: null };
    } catch (e) {
      return { ok: false, status: null, models: [], error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  });

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

  // ── docs（##404 #3：仓库文档索引；变量树只放摘要，逐篇按需在这里取）──
  binding.on(app.docs.index, async ({ input }) => {
    const roots = input.roots === undefined
      ? undefined
      : input.roots.split(",").map((s) => s.trim()).filter((s) => s !== "");
    // 缺省根 = **app 进程 cwd 向上找到的仓库根**（不是 process.cwd() 本身）：
    // app 进程的 cwd 是包目录（`pkgs.ts/diy-app`），直接拿它扫 `docs/plans` 永远是空。
    // 这也解释了为什么必须显式传 `--dir` 或依赖上溯 —— CLI 敲命令的 cwd 到不了这里。
    const idx = buildDocsIndex({
      root: input.dir ?? findRepoRoot(process.cwd()) ?? process.cwd(),
      ...(roots === undefined ? {} : { roots }),
      ...(input.max === undefined ? {} : { maxEntries: input.max }),
    });
    // 没有文档 = 空索引（不是 null）：CLI 的返回形状要稳定，空 = "这个根下没扫到"，
    // 与"变量树里整节缺席"是两件事（后者是上下文层的纪律）。
    return idx ?? { roots: roots ?? [...DEFAULT_DOCS_ROOTS], entries: [] };
  });

  // ── facts（##404：项目级事实库；agent 只经 RPC 读写，不碰 YAML）──
  binding.on(app.facts.status, async ({ input }) => factsStore.status({ ...(input.dir === undefined ? {} : { dir: input.dir }), ...(input.in === undefined ? {} : { in: input.in }) }));
  binding.on(app.facts.get, async ({ input }) =>
    factsStore.get(factsStore.splitList(input.claim), {
      ...(input.dir === undefined ? {} : { dir: input.dir }),
      ...(input.in === undefined ? {} : { in: input.in }),
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.path === undefined ? {} : { paths: factsStore.splitList(input.path) }),
      ...(input.task === undefined ? {} : { task: input.task }),
    }),
  );
  binding.on(app.facts.brief, async ({ input }) =>
    factsStore.brief(input.subject, {
      ...(input.dir === undefined ? {} : { dir: input.dir }),
      ...(input.in === undefined ? {} : { in: input.in }),
      ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
    }),
  );
  binding.on(app.facts.find, async ({ input }) =>
    factsStore.find(input.keyword, {
      ...(input.dir === undefined ? {} : { dir: input.dir }),
      ...(input.in === undefined ? {} : { in: input.in }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
    }),
  );
  binding.on(app.facts.submit, async ({ input }) =>
    factsStore.submitPayload(factsStore.parseSubmitPayload(input.file), {
      ...(input.dir === undefined ? {} : { dir: input.dir }),
      ...(input.in === undefined ? {} : { in: input.in }),
      // 调用方 cwd（CLI parser 注入）：缺省库目录要按**敲命令的那个 shell** 找，
      // 不是主进程 cwd（##437，主进程 cwd = 应用目录 = 主仓）。
      ...(input.cwd === undefined ? {} : { callerCwd: input.cwd }),
      dryRun: input.dryRun === true,
    }),
  );
  binding.on(app.facts.raw, async ({ input }) => factsStore.raw({
    ...(input.dir === undefined ? {} : { dir: input.dir }),
    ...(input.in === undefined ? {} : { in: input.in }),
  }));
  binding.on(app.facts.project, async ({ input }) => factsStore.projectFacts({
    ...(input.dir === undefined ? {} : { dir: input.dir }),
    ...(input.in === undefined ? {} : { in: input.in }),
    ...(input.algorithm === undefined ? {} : { algorithm: input.algorithm }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.path === undefined ? {} : { paths: factsStore.splitList(input.path) }),
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.includeProposed === undefined ? {} : { includeProposed: input.includeProposed }),
  }));
  binding.on(app.facts.affected, async ({ input }) => factsStore.affectedByFiles(factsStore.splitList(input.files), {
      ...(input.dir === undefined ? {} : { dir: input.dir }),
      ...(input.in === undefined ? {} : { in: input.in }),
    }));

  // ── journal（##404：任务日志 = append-only 事件流；把"发生过什么"从任务 body 里摘出来）──
  binding.on(app.journal.add, async ({ input }) => {
    const body = journalStore.resolveBody(input.body, input.bodyText, input.bodyFile);
    return journalStore.addEntries(input.task, [
      {
        kind: input.kind,
        title: input.title,
        ...(body === undefined ? {} : { body }),
        ...(input.refs === undefined ? {} : { refs: journalStore.splitRefs(input.refs) }),
        ...(input.round === undefined ? {} : { round: input.round }),
        ...(input.author === undefined ? {} : { author: journalStore.parseAuthorSpec(input.author) }),
        ...(input.anchor === undefined ? {} : { anchor: journalStore.parseAnchorSpec(input.anchor) }),
      },
    ]);
  });
  binding.on(app.journal.raw, async ({ input }) => journalStore.rawJournal(input.task));
  binding.on(app.journal.find, async ({ input }) =>
    journalStore.findJournal(input.task, {
      ...(input.kind === undefined ? {} : { kind: journalStore.splitKinds(input.kind) }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      ...(input.grep === undefined ? {} : { grep: input.grep }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.order === undefined ? {} : { order: input.order }),
    }),
  );
  binding.on(app.journal.stats, async ({ input }) => journalStore.journalStats(input.task));
  binding.on(app.journal.import, async ({ input }) =>
    journalStore.importEntries(input.task, journalStore.parseImportPayload(input.file), input.dryRun === true),
  );

  // ── seed ──
  binding.on(app.seed.run, async () => {
    const r = seedHome(state.diyHome());
    // 种子可能新写了 model.yaml → 重装目录，让 UI 立刻看到模型
    refreshModelRuntime(state.diyHome());
    return r;
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

  // ── room（多人房间；开发日志 ##377，设计真源 ##166 §28）──
  // room = **投递 + 汇总层**：成员各自独立会话，这里只负责"收一句话 → 投给谁 → 把回复带署名汇总回来"。
  // 投递器在 services/room-service.ts（真起一轮的是它，不是本绑定层）；落盘层在 core/room.ts。
  binding.on(app.room.list, async () => {
    const { listRooms, readEvents } = await import("../core/room");
    const rooms = [];
    for (const r of listRooms()) {
      // 只要最后一条 ⇒ 倒读 1 行（##427：不再是整份读 + 解析）
      const { events } = await readEvents(r.id, { limit: 1 });
      const last = events[events.length - 1];
      rooms.push({
        id: r.id,
        ...(r.title ? { title: r.title } : {}),
        focus: r.focus,
        members: r.members.length,
        ...(last ? { last: `${shortName(last.author)}: ${last.text.slice(0, 60)}` } : {}),
      });
    }
    return { rooms };
  });
  binding.on(app.room.get, async ({ input }) => {
    // 走 readRoomViewCached（不是裸 readEvents）：投递状态在 deliveries.jsonl 里，要 fold 上来；
    // 缓存按文件签名失效 + 合并并发（##427：同一房间在同一次刷新窗口里被多个组件读多遍盘）
    const { readRoomViewCached } = await import("../core/room-view-cache");
    const { ensureRoomForTask } = await import("./room-service");
    const { withSteerTurns } = await import("../../shared/room");
    const { getLocalAgent } = await import("./local-agent");
    // 宿主定案（§28.7 G）：id = taskUri，且**每个任务恒是一个 room** ⇒ 读之前先补齐成员表
    await ensureRoomForTask(input.id);
    const { room, events, bad } = await readRoomViewCached(input.id, { limit: input.limit ?? 200 });
    // 忙时插话那条的 **turnId 是读侧投影**（##377 第 29 刀）：投递时只知道「插进了正在跑的那一轮」，
    // 队列项落位之后才有块带 `meta.steerId` ⇒ 现在问 `local-agent` 反查得到。
    // 不落盘：它不是事件事实，而是"拿着既有键（steerId）现算的地址"（owner 口径：别造回复映射）。
    const agent = getLocalAgent();
    const withTurns = withSteerTurns(events, (taskUri, steerId) => agent.steerTurnId(taskUri, steerId));
    return { room, events: [...withTurns], badLines: bad };
  });
  binding.on(app.room.create, async ({ input }) => {
    const { isValidRoomId } = await import("../core/room");
    const { ensureRoomForTask } = await import("./room-service");
    if (!isValidRoomId(input.id)) throw new Error(`房间 id 不合法：${input.id}（room id = 任务 URI）`);
    return await ensureRoomForTask(input.id);
  });
  binding.on(app.room.addMember, async ({ input }) => {
    const { upsertMember } = await import("../core/room");
    const { ensureRoomForTask } = await import("./room-service");
    const room = await ensureRoomForTask(input.id);
    const taskUri = input.task ?? "";
    // 护栏：**同一 backend 不得挂两个人物**（= A 帽子，##166 §27 已否）
    const dup = room.members.find((m) => m.backend?.type === "task" && m.backend.data.taskUri === taskUri && taskUri);
    if (dup) throw new Error(`会话 ${taskUri} 已挂了成员 ${dup.name}（同一 backend 不得挂两个人物）`);
    return upsertMember(input.id, {
      id: `agent:${input.name}`,
      name: input.name,
      kind: "agent",
      backend: { type: "task", data: { taskUri } },
      ...(input.persona ? { persona: input.persona } : {}),
      ...(input.role ? { role: input.role } : {}),
    });
  });

  /**
   * **邀请 = 选人物**（##166 §28.7 F ② / D 的 B 方案：影子 task）。
   *
   * 三条口径：
   *   · 面板列**人物**（不列 task）：调用方给人物 id 或名字；
   *   · backend 缺省**自动建一个专属影子 task**（复用现有一切，零内核改动）——`--task` 是高级入口；
   *   · 护栏：同一 backend 不得挂两个人物（§27 已否 A 帽子）；同一人物可进多个 room。
   */
  binding.on(app.room.invite, async ({ input }) => {
    const { upsertMember } = await import("../core/room");
    const { ensureRoomForTask } = await import("./room-service");
    const { listPersonas } = await import("../core/persona");
    const { diyHome } = await import("../core/state");
    const room = await ensureRoomForTask(input.id);
    const personas = listPersonas(diyHome());
    const p = personas.find((x) => x.id === input.persona || x.name === input.persona);
    if (!p) throw new Error(`没有这个人物：${input.persona}（diy agent persona list 看可用人物）`);
    // 高级入口：指定绑已有 task；否则建影子 task（title 里带宿主任务，便于回溯）
    const given = input.task?.trim();
    let taskUri = given ?? "";
    let createdTask = false;
    if (!taskUri) {
      // 影子 task 落在**宿主任务所在的 project**（宿主不在本数据根时回落到第一个可用 project）——
      // "藏进专属 project"是 ##166 §28.7 D 的后话，探索期跑通优先。
      // 建法与 §30 侧边栏主人格**同一份**（room-service::createShadowTask），不各写一遍。
      const { createShadowTask } = await import("./room-service");
      taskUri = await createShadowTask(input.id, p);
      createdTask = true;
    }
    const dup = room.members.find((m) => m.backend?.type === "task" && m.backend.data.taskUri === taskUri);
    if (dup) throw new Error(`会话 ${taskUri} 已挂了成员 ${dup.name}（同一 backend 不得挂两个人物）`);
    // 成员 id 用**人物名**（`@` 寻址的直觉就是喊名字；重名时加序号）；name 同名 —— UI 显示用
    const base = p.name.trim().replace(/\s+/g, "-");
    let memberId = `agent:${base}`;
    for (let n = 2; room.members.some((m) => m.id === memberId); n++) memberId = `agent:${base}-${n}`;
    const member = {
      id: memberId,
      name: p.name,
      kind: "agent" as const,
      persona: p.id,
      backend: { type: "task" as const, data: { taskUri } },
      ...(input.role ? { role: input.role } : {}),
    };
    const next = upsertMember(input.id, member);
    return { room: next, member, taskUri, createdTask };
  });

  binding.on(app.room.removeMember, async ({ input }) => {
    const { readRoom, removeMember } = await import("../core/room");
    const { resolveMember } = await import("../../shared/room");
    const { ensureRoomForTask } = await import("./room-service");
    await ensureRoomForTask(input.id);
    const room = readRoom(input.id);
    if (!room) throw new Error(`房间不存在：${input.id}`);
    const memberId = resolveMember(room, input.member);
    if (!room.members.some((m) => m.id === memberId)) throw new Error(`房间里没有这个成员：${input.member}`);
    return removeMember(input.id, memberId);
  });
  binding.on(app.room.focus, async ({ input }) => {
    const { readRoom, setFocus } = await import("../core/room");
    const { ensureRoomForTask } = await import("./room-service");
    const { resolveMember } = await import("../../shared/room");
    await ensureRoomForTask(input.id);
    const room = readRoom(input.id);
    if (!room) throw new Error(`房间不存在：${input.id}`);
    const member = input.member ? resolveMember(room, input.member) : null;
    if (member && !room.members.some((m) => m.id === member)) throw new Error(`房间里没有这个成员：${input.member}`);
    return setFocus(input.id, member);
  });
  /**
   * 人成员的阅读游标前移（##377 第 28 刀）。
   *
   * ⚠️ 只有人成员的游标能从这里动（判据在 `core/room.markRead`）—— agent 的水位归投递 / 成轮。
   */
  binding.on(app.room.read, async ({ input }) => {
    const { readRoom, markRead } = await import("../core/room");
    const advanced = await markRead(input.id, input.event);
    const room = readRoom(input.id);
    if (!room) return { room: null, advanced: false, read: null };
    const human = room.members.find((m) => m.kind === "human");
    const event = human ? room.lastSeen[human.id] : undefined;
    return {
      room,
      advanced,
      read: human && event ? { member: human.id, event } : null,
    };
  });
  binding.on(app.room.post, async function* ({ input }) {
    const { postToRoom } = await import("./room-service");
    for await (const ev of postToRoom(input.id, input.text)) yield JSON.stringify(ev);
  });
  /**
   * 一条 reply 的进度（##166 §28.7 A）：**不新造数据源** ——
   * 房间只存了引用（`ref = { memberUri, turnId }`），进度本身在成员会话的 ops 流里，
   * 这里把它取回来交给渲染端（与任务对话同一个块树、同一个渲染器）。
   */
  binding.on(app.room.turn, async ({ input }) => {
    const { readRoom, readRoomView } = await import("../core/room");
    const { ensureRoomForTask } = await import("./room-service");
    const { resolveMember } = await import("../../shared/room");
    const { getLocalAgent } = await import("./local-agent");
    const { sessionRegistry } = await import("./session-registry");
    // 两种寻址：`(成员, 轮次)` 字面口径 ｜ `reply 事件 id` room 便利形态（事件自带 ref）
    let taskUri: string;
    let turnId: string;
    let memberUri: string | null = null;
    if (input.member && input.turn) {
      await ensureRoomForTask(input.id);
      const room = readRoom(input.id);
      if (!room) throw new Error(`房间不存在：${input.id}`);
      const memberId = resolveMember(room, input.member);
      const m = memberId ? room.members.find((x) => x.id === memberId) : undefined;
      if (!m) throw new Error(`房间里没有这个成员：${input.member}（room get 看成员表）`);
      const tu = m.backend?.type === "task" ? m.backend.data.taskUri : "";
      if (!tu) throw new Error(`成员 ${m.id} 没绑任务会话，没有进度可取（backend 缺 taskUri）`);
      taskUri = tu;
      turnId = input.turn;
      memberUri = m.id;
    } else {
      if (!input.event) throw new Error("要么给 --event（reply 事件 id），要么给 --member + --turn");
      // limit: 0 = **全量**（要按 id 反查任意一条历史事件，尾部窗口答不了 —— 这是人为操作、不是轮询）
      const { events } = await readRoomView(input.id, { limit: 0 });
      const ev = events.find((e) => e.id === input.event);
      if (!ev) throw new Error(`房间里没有这条事件：${input.event}（room get 看事件 id）`);
      const ref = ev.ref;
      if (!ref || !ev.sourceTask) throw new Error(`这条事件没有进度引用（不是被投递的 reply）：${input.event}`);
      taskUri = ev.sourceTask;
      turnId = ref.turnId;
      memberUri = ref.memberUri;
    }
    const agent = getLocalAgent();
    return {
      turn: agent.turnNode(taskUri, turnId),
      taskUri,
      turnId,
      memberUri,
      live: sessionRegistry.activeTurnList().some((t) => t.uri === taskUri),
      entry: sessionRegistry.entryOf(taskUri),
      action: agent.currentAction(taskUri),
    };
  });

  /**
   * 房间成员的**此刻状态**（L1；##166 第三轮口径第 3 条：服务端能给出，不靠 UI 猜）。
   *
   * 合成三份既有真源（不新造状态）：
   *   · 会话侧 —— `sessionRegistry.entryOf(taskUri)`（steps / startedAt / state / viewers / lastEndReason）
   *   · 进度侧 —— `local-agent.currentAction`（未闭合块 ⇒「正在 bash · rg -n …」）
   *   · room 侧 —— 投递链上的 `queued` / `running` 条数（盘上 fold 出的投递快照，无状态）
   * 纯读、无副作用；任何布局的「头像行状态」都吃这一份（详情另走 `turn`）。
   */
  binding.on(app.room.roster, async ({ input }) => {
    const { readRoom } = await import("../core/room");
    const { readDeliveriesCached } = await import("../core/room-view-cache");
    const { ensureRoomForTask } = await import("./room-service");
    const { getLocalAgent } = await import("./local-agent");
    const { sessionRegistry } = await import("./session-registry");
    const { memberAvatar, memberColor, orderedMembers } = await import("../../shared/room");
    await ensureRoomForTask(input.id);
    const room = readRoom(input.id);
    if (!room) throw new Error(`房间不存在：${input.id}`);
    // 本端点只要「谁在排队 / 谁在跑」⇒ 直接吃 deliveries 的 fold（**不碰事件流**）：
    // 旧实现为这几个计数把整条事件流读了一遍（limit: 0 = 全量，5 MB 时每次轮询 ~百 ms 级）。
    const { byEvent } = await readDeliveriesCached(input.id);
    const states = [...byEvent.values()].flatMap((inner) => [...inner.values()]);
    const agent = getLocalAgent();
    const members = orderedMembers(room).map((m, i) => {
      const taskUri = m.backend?.type === "task" ? m.backend.data.taskUri || null : null;
      let queued = 0;
      let running = 0;
      for (const d of states) {
        if (d.memberId !== m.id) continue;
        if (d.status === "queued") queued++;
        else if (d.status === "running") running++;
      }
      return {
        memberId: m.id,
        name: m.name,
        avatar: memberAvatar(m, i),
        color: memberColor(m),
        role: m.role ?? (m.kind === "human" ? "人类（房间主人）" : "agent"),
        isHuman: m.kind === "human",
        focus: room.focus === m.id,
        taskUri,
        entry: taskUri ? sessionRegistry.entryOf(taskUri) : null,
        action: taskUri ? agent.currentAction(taskUri) : null,
        queued,
        running,
      };
    });
    return { room: room.id, now: Date.now(), members };
  });

  // ── instances（实例大盘；##366）──
  // 发现/聚合/唤起的实现在 services/instances.ts（纯规则在 core/instance-*），这里只做绑定。
  // `ls` 与 `list` 是**同一份数据两种出口**：前者给人看（表格文本），后者给 UI/程序（结构化行）。
  binding.on(app.instances.ls, async () => renderInstanceList());
  binding.on(app.instances.list, async () => ({ rows: await collectInstances() }));
  binding.on(app.instances.self, async () =>
    selfReport({ window: windowState(), branch: currentGitBranch() ?? "", repoDisplay: repoDisplayOf() }),
  );
  binding.on(app.instances.reveal, async () => revealSelf());
  binding.on(app.instances.focus, async ({ input }) => {
    if (input.pid === undefined && input.port === undefined) {
      throw new Error("必须给 --pid 或 --port（目标实例；先跑 diy instances ls 看当前有哪些）");
    }
    const r = await focusInstance({ pid: input.pid, port: input.port });
    return { pid: r.pid, port: r.port, via: r.via, reason: r.reason };
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
