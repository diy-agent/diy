/**
 * api-impl.ts — Main 进程 RPC handler 绑定（handle 分离）
 *
 * 从 api-def.ts 导入纯 meta，通过 binding.on(meta, handler) 逐个绑定实现。
 * 业务逻辑在这里，schema 定义在 api-def.ts。
 * 命名体系：diy.*（Main 进程域，本地处理）。diy.ui.* 由调用方 onForward 转发。
 */

import type { ServerBinding } from "@diy-agent/rpc";
import { ChannelServerBinding, assertFullyBound } from "@diy-agent/rpc";
import type { EnvelopeTransport } from "@diy-agent/rpc";

import * as state from "../core/state";

import { refreshModelRuntime } from "../core/model-runtime";

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
import { bindFlow } from "./api-domains/flow/impl";
import { bindAgent } from "./api-domains/agent/impl";

import { bindInstances } from "./api-domains/instances/impl";
import { bindRemote } from "./api-domains/remote/impl";
// app 域只在 api-def 里登记 meta 还不够 —— 不 bind 就没有 handler，
// 客户端会收到 `Unknown method: diy.app.info`（见下方调用点注释）。
import { bindApp } from "./api-domains/app/impl";

import * as health from "./health";
import { apiDef } from "./api-def";

import { noteWriteError } from "./env-watch";
import { setWriteErrorHook } from "../core/atomic-write";

/**
 * 实际 RPC 监听端口，由入口在绑定完成后回填。
 * 不能靠 app.port 文件推：serve 模式不写该文件，读到的会是 Electron 留下的陈旧值。
 *
 * 2026-11 起真正的存放点是 `api-domains/app/impl.ts` 的 `rpcPort` —— 这里只做 re-export，
 * 保持 `main/index.ts` / `serve/index.ts` 的老 import 路径不变。
 */
export { setRpcPort } from "./api-domains/app/impl";

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

  // ── app（进程/环境自述）──
  // ⚠️ 必须绑：`diy.app.info` 不只给设置页看，**CLI 的实例探活也靠它**
  // （cli/probe-instance.ts → fetchAppInfo）。漏绑时 app 明明起来了，CLI 却认不出
  // 「这个端口是我的实例」→ 空转 30s 后报「启动超时」，并顺带把刚起的实例杀掉。
  // 同理 renderer 首屏（App.tsx / SidebarRoom）会报 Unknown method。
  bindApp(binding);

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

  // —— watch —— 文件系统变更推送（serverStream：FileWatcher → RPC → renderer）
  // 在 diy.watch.*（Main 域）：diy.ui.* 会被 rpc-port 全量转发给 renderer，
  // 挂那里会与本地注册冲突（ServerBinding 抛「已注册」→ RPC 起不来）。
  bindWatch(binding);

  // ── agent（38 个 handler 已拆到 api-domains/agent/）──
  bindAgent(binding);
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

  // ── flow（15 个 handler 已拆到 api-domains/flow/）──
  bindFlow(binding);
  // `--file` 的内容由**调用方进程**的 CLI parser 读好送进来（stdin / 相对路径都归它，见 _cli-meta.readFile）
  // ── flow（15 个 handler 已拆到 api-domains/flow/）──
  // ##342：`--opinion` = 意见正文一等落盘（落进讨论流、挂这次打回的锚点）。
  // 锚点不用调用方传：`bounceFlow` 的回执折线末条就是这次的落点驻留（唯一标识这条打回边的穿越）。
  // ── flow（15 个 handler 已拆到 api-domains/flow/）──
  // ##342：讨论线程（只读 + 发言）。旁注坏了不外抛（`listThreads` 报 `skipped` / `error`），
  // 写侧的唯一闸门「锚点必须是真打回」在 `core/flow-thread.ts::requireRealBounce`。
  // ── flow（15 个 handler 已拆到 api-domains/flow/）──
  // ##341：系统推一步（真求值 pred:/action:）—— 与上面两条「宣布」命令走的是不同那条路
  // ── flow（15 个 handler 已拆到 api-domains/flow/）──
  // ##341 驱动环：流式（逐帧）+ **客户端断开即中断**（signal 一路传到在跑的 agent 轮次）
  // ── flow（15 个 handler 已拆到 api-domains/flow/）──

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


  // 装配完整性对账：apiDef 声明的每个方法都必须有人 bind（反之亦然）。
  // 2026-11-09 就是漏了 `bindApp` —— meta 在、handler 不在，CLI 探活因此失败、
  // 报「启动超时」还把自己杀掉。这里在**启动时**就炸，不留到第一条请求。
  // `diy.ui.*` 是 **renderer 侧**绑的（见 renderer-api-impl.ts）—— main 的 binding 上
  // 本来就不该有它们，排除掉
  assertFullyBound(binding, apiDef.diy, "diy-app", ["diy.ui."]);
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

