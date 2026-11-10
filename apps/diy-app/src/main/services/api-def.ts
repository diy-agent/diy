/**
 * api-def.ts — RPC 纯定义（meta，无 call）
 *
 * 只含 zod schema，供 server 端绑定 handler（api-impl.ts）和
 * 客户端 createTypedClient 推导强类型。
 * 命名与 py 侧 `diy <域> <命令>` 对齐。
 *
 * 命名体系：
 *   diy.*      — Main 进程域（本地处理）
 *   diy.ui.*   — Renderer 进程域（Main 经 onForward 转发，Renderer 本地处理）
 *
 * 结构不变量：RPC 树的每个可见命令节点必须是 RpcSchema.group / unary / serverStream /
 * clientStream / bidiStream 之一——父命令用 group（承载 desc），叶子命令用四种流工厂
 * （承载 desc），保证 CLI help 每一层（含根 `diy`）都有说明。`app` 是进程域前缀
 * （cliRootPath 摊平、非可见命令），作为裸 _Router 容器。
 * 所有 desc 用反引号模板字符串，便于扩展成多行（help 第一行作命令列表摘要）。
 */

import { RpcSchema } from "@diy-agent/rpc";
import { SteerItemSchema } from "../../shared/steer-item";
import { agentRoutes } from "./api-domains/agent/api";
import { TaskNodeSchema } from "../../shared/task-node";
import { UiSnapshotData } from "../../shared/ui-snapshot";
import { uiRoutes } from "./api-domains/ui/api";
import { flowRoutes } from "./api-domains/flow/api";
import { FlowNodeSchema, FlowRendererSchema, FlowEdgeSchema, FlowArtSchema, FlowPayloadViewSchema, FlowVisitSchema, FlowViewSchema, FlowArtifactViewSchema, FlowAnchorSchema, FlowPostSchema, FlowThreadSchema, FlowThreadsSchema, kvList } from "../../shared/flow";
import { taskRoutes } from "./api-domains/task/api";
import { appRoutes } from "./api-domains/app/api";
import { StatusOk, StatusDataId, StatusDataUri } from "../../shared/status";
import { envRoutes } from "./api-domains/env/api";
import { cacheHintRoutes } from "./api-domains/cacheHint/api";
import { projectRoutes } from "./api-domains/project/api";
import { roomRoutes } from "./api-domains/room/api";
import { hubRoutes } from "./api-domains/hub/api";
import { journalRoutes } from "./api-domains/journal/api";
import { jobRoutes } from "./api-domains/job/api";
import { remoteRoutes } from "./api-domains/remote/api";
import { instancesRoutes } from "./api-domains/instances/api";
import { noticeRoutes } from "./api-domains/notice/api";
import { templateRoutes } from "./api-domains/template/api";
import { contextRoutes } from "./api-domains/context/api";
import { trafficRoutes } from "./api-domains/traffic/api";
import { llmConfigRoutes } from "./api-domains/llmConfig/api";
import { factsRoutes } from "./api-domains/facts/api";
import { kbRoutes } from "./api-domains/kb/api";
import { docsRoutes } from "./api-domains/docs/api";
import { llmProxyRoutes } from "./api-domains/llmProxy/api";
import { watchRoutes } from "./api-domains/watch/api";
import { toolRoutes } from "./api-domains/tool/api";
import { logRoutes } from "./api-domains/log/api";
import { seedRoutes } from "./api-domains/seed/api";
import { z } from "zod";
// 引擎通用渲染器 id 的真源（别处不复制这份清单；内核加渲染器时这里的 schema 自动跟上）
import { RENDERERS } from "@diy-agent/flow";
import { PromptEntrySchema, RequestPreviewSchema } from "@diy-agent/context/schema/prompt-schema";
import { TrafficRecordSchema } from "../../shared/traffic-record";
import { ContextDiffSchema, CtxLogSchema, StatsSchema, StepsSchema } from "../../shared/context/schema";
import { ContextLabSchema, ContextPlaceCandidateSchema } from "../../shared/context/schema";
// 多人房间契约（shared，renderer 同源）
import { RoomEventSchema, RoomMemberSchema, RoomSchema } from "../../shared/room";
// agent 人物契约（纯 zod，renderer 同源）——模型/参数/行为指令的配置实体
import { FALLBACK_MODEL } from "../../shared/model-default";
import { PersonaSchema } from "../../shared/persona";
// 价格形状（camelCase 运行时口径）：与 UI/CLI 同一份 schema
import { ModelCostSchema } from "../../shared/usage";
// 「模型不可用」通知契约（纯 zod，renderer 同源；判据函数也在同文件，见 ##369）
import { ModelUnavailableNoticeSchema } from "../../shared/model-unavailable";
// 事实库契约（##404）：形状在 shared/facts.ts，语义校验在内核 @diy-agent/facts
import {
  EnvSchema,
  FactsAffectedSchema,
  FactsBriefSchema,
  FactsFindSchema,
  FactsGetSchema,
  FactsProjectSchema,
  FactsRawSchema,
  FactsStatusSchema,
  FactsSubmitSchema,
} from "../../shared/facts";
// 任务日志契约（##404）：append-only 事件流，见 shared/journal.ts 头注（三分法）
import { DocsIndexSchema } from "../../shared/docs";
import { JournalAddSchema, JournalFindSchema, JournalImportSchema, JournalRawSchema, JournalStatsSchema } from "../../shared/journal";
// 「环境感知」通知契约（##384）：磁盘满 / 网断 —— 与 notice.* 同形不同源
import { EnvNoticeSchema, EnvNoticeEventSchema } from "../../shared/env-watch";
// 冷缓存提示契约（##477）：顶栏一行 + 用量面板「缓存时效柱」，同源（维度 = provider × model）
import { CacheChannelViewSchema, CacheHintEventSchema, CacheHintSchema } from "../../shared/cache-hint";
import { InboxEntrySchema } from "../../shared/inbox";
import {
  CostUpdateResultSchema,
  ImportEnvResultSchema,
  LlmConfigViewSchema,
  ModelConfigFileSchema,
  ModelsRefreshResultSchema,
  ModelsSnapshotInfoSchema,
  ProbeResultSchema,
  ProviderCostsViewSchema,
  ScanEnvResultSchema,
  SeedReportSchema,
  SpecProviderSchema,
  TierWriteSchema,
} from "../../shared/model-config";
// 草稿与任务详情载荷的契约（纯 zod，renderer 同源）
import { DraftFieldSchema, DraftFieldsSchema, DraftsData, TaskDetailSchema } from "../../shared/task-detail";
// 实例大盘契约（shared，renderer 同源）：一行 = 一个实例
import { InstanceRowSchema, InstanceSelfSchema, RevealResultSchema } from "../../shared/instance-row";
// 远程实例契约（##479，shared，renderer 同源）：/ping 身份 + 发现结果
import {
  DiscoverFailureSchema,
  RemoteDiscoverResultSchema,
  RemotePingResultSchema,
  RemoteSelfSchema,
} from "../../shared/remote";

// 任务状态枚举 — 单一真相源 task-state.ts（纯 zod，无 Node 依赖，浏览器安全） */
import { TaskStateSchema } from "../core/task-state";
import { ChangeTypeSchema, PrioritySchema } from "../core/task-fields";

/** task create 的回报：uri + **归属回显**（project id / label / path）。
 *  为什么回显（##430）：创建只回 uri 时，人看不出落到了哪个仓 —— 同名 id（两个项目都有 tasks/92）
 *  要等很久以后靠撞车才发现。label/path 不长，多回两个字段就能一眼认出。 */
const CreateResult = z.object({
  status: z.string(),
  data: z.object({
    uri: z.string(),
    /** 实际落到的 project id */
    project: z.string(),
    label: z.string().optional(),
    path: z.string().optional(),
  }),
});
/** task edit 的回报：uri + 本次写入实际做了什么（剥头 / 追加）—— 见 core/task.ts 的 TaskWriteReport。
 *  可选字段（不剥头/不追加就不出现）：避免调用方从"空对象"里猜发生了什么。 */
const StrippedHeadReportSchema = z.object({
  keys: z.array(z.string()),
  /** 被剥掉的头**原文**（调用方据此核对丢了什么内容 —— 只报键名看不出） */
  head_text: z.string(),
  /** 与文件现有头不一致、**未写回**的键（文件头才是权威） */
  differs: z.array(z.string()).optional(),
});
const StatusDataTaskWrite = z.object({
  status: z.string(),
  data: z.object({
    uri: z.string(),
    /** 入参 `--body` 其实是「整份文件」→ 头已剥离取正文（`--append-body` 的严判据见 core/task.ts） */
    body_head_stripped: StrippedHeadReportSchema.optional(),
    /** 入参 `--append-body` 其实是「整份文件」→ 头已剥离取正文 */
    append_head_stripped: StrippedHeadReportSchema.optional(),
    /** 本次实际追加的字符数 */
    appended_chars: z.number().optional(),
  }),
});


/** 任务树节点 schema（递归，供 ui.tree 输出强类型） */
/** UI 快照数据（ui.state 单读 / ui.watch.uiState 流 共用同一形状） */
// 草稿契约在 shared/task-detail.ts（单一真源，renderer 同源）；re-export 保持既有引用路径不变
export { DraftFieldSchema, DraftFieldsSchema, DraftsData, TaskDetailSchema };

/**
 * 插话项（对话中「插嘴」的待投递消息）。
 * 与草稿同文件同生命周期（任务目录 .diy/drafts.yaml 的 steers 字段），
 * 但语义是**队列**：FIFO，提交后等模型取走。两种模式**都是整批取走**（多条合并成同一批），
 * 差别只在投递点：next-step = 下一个模型步边界之前（本轮内生效）；next-turn = 本轮收尾后的下一轮开场。
 */
/** ── 工作流（##319）──────────────────────────────────────────────
 * 形状与 core/flow.ts 的视图一一对应。注意：**outputSchema 运行期不校验**（只用于类型推导，
 * 见 pit.rpc-output-schema），故这里写的是契约、不是闸门 —— 改 handler 出参时两边一起改。 */
/** 当前节点（hint 已经内核 `renderHint` 插值 —— 宿主不再自己拼字符串） */
/** 引擎通用渲染器 id —— **真源是内核 `define.ts` 的 `RENDERERS`**（schema 只是引用它，不复制清单） */
/** 一条出边：「卡在哪条边」的数据源 */
/**
 * 节点产物的**展示链**（内核 `NodeDef.art`，##337）—— 声明「这一步的产物长什么样、翻给哪个渲染器」：
 * `raw` 是行业知道的产物形状（说明文本），`renderer` 是引擎九种通用渲染器之一（合法值真源 = 内核
 * `RENDERERS`），`plugin` 是宿主注册的 render 插件名（**给 null / 不给 = 直吃 raw**）。
 */
/** 一份**译好**的产物视图（内核 `View`）：renderer + 给它的 payload（宿主**原样透传**，不校验形状） */
/** 折线上一次驻留（领域事实：node/seq/kind/at + 宿主关联 ref） */
/** 实例视图（show / start / advance / bounce / params.set 同一份回执形状） */
/** 一份产物视图（`diy flow view` / `flow artifact put` 的回执；形状与 core/flow.ts 的 `FlowArtifactView` 一致） */
/**
 * 讨论线程（##342）：一条发言 + 一条线程（锚点 = 一次**真打回边**的穿越）。
 *
 * 形状与 `core/flow-store.ts` 的 `FlowPost` / `core/flow-thread.ts` 的 `FlowThreadView` 一一对应。
 * 锚点 `{from,to,seq}`：`from` = 打回前位置、`to` = 落点节点、`seq` = **落点那次驻留**的序号
 * （一次 bounce 恰创生一次驻留 ⇒ 三元组唯一；同节点二次打回各是各的）。
 */
/** `flow thread list` / `flow thread post` 的载荷（同一份形状：post 回执顺手把新表带回来，UI 不必再调一次） */
/**
 * 「多个 `k=v`」型 CLI 入参：JSON 数组（与既有 array 选项同形，parser 会 JSON.parse）或单个裸值。
 *
 * ⚠️ 必须是**工厂**不是共享常量：`cliOption` 的元数据注册在 `_unwrap()`（剥掉 optional 后的那层）上，
 * 共用一个 schema 对象会让后注册的 desc 覆盖前面每个使用点（help 文案串台）。
 */
export const apiDef = RpcSchema.group({ children: {
  diy: RpcSchema.group({
    desc: `
    diy 管控台 CLI
    管控台命令行工具，提供任务管理、主题管理、Agent 对话、LLM 代理、日志查看等功能。
    `,
    children: {
      app: appRoutes,
      task: taskRoutes,

      project: projectRoutes,


      // 运行环境详情：设置页「状态」标签用，同时天然可被 CLI 调用。
      // 历史上它只是一条 ipcMain.handle("getAppInfo")，preload 没桥接、api-def 也没登记，
      // 于是 Electron 里 window.diy 为 undefined（可选链短路，永远卡在「加载中…」）、
      // serve 里方法不存在。走 RPC 后三种入口共用同一实现。

      doctor: RpcSchema.unary({
        desc: `系统健康自检`,
        input: {},
        output: z.object({
          status: z.string(),
          data: z.object({
            pid: z.number(),
            home: z.string(),
            state_exists: z.boolean(),
            issues: z.array(z.string()),
            healthy: z.boolean(),
            /**
             * 实际生效的模型目录快照（##385 §3.1）：**必须能说出读的是哪一份**。
             * `source` 区分 `diy-home`（应用内刷新写的）/ `bundle`（发行产物）/ `source-tree`（源码树），
             * 排查「明明刷新了为什么没生效」时先看这里。null = 一份都没有 / 解析失败（见 issues）。
             */
            models: ModelsSnapshotInfoSchema.nullable(),
          }),
        }),
      }),




      // agent 域已拆到 `api-domains/agent/`（内部再分 persona / local / usage）
      agent: agentRoutes,

      /**
       * 多人房间（room）—— 人 + 多 agent 同室对话的**投递 + 汇总层**。
       *
       * 设计真源 ##166 §28：room ≠ session（不承载成员上下文）；成员各自独立会话
       * （本切片按待决 72 的 (a)：agent 成员绑一个 task 的本地会话）；投递由 `@X` / `focus`
       * 决定、**协议里没有广播**。开发日志 ##377。
       */
      room: roomRoutes,

      /**
       * 文件读取工具（行窗口 + 续读）。
       *
       * 为什么不复用内置 read 工具：内置 read 是**模型工具调用**，只在 agent 会话里可达；
       * CLI 侧需要一份等价能力 —— agent 可经 bash 调它（绕开工具输出的截断），人也能直接看。
       * 两侧共用 core/file-read.ts 的同一实现（窗口语义只有一份，见该文件头注释）。
       */
      tool: toolRoutes,

      // —— 提示词模版试验场（spike）：内置只读 + 项目级同路径覆盖 + dry-run 预览 ——
      template: templateRoutes,

      context: contextRoutes,

      llmProxy: llmProxyRoutes,

      traffic: trafficRoutes,

      llmConfig: llmConfigRoutes,

      // seed 域已拆到 `api-domains/seed/`（2026-11-06，模块化试水）。
      // 这里仍挂进大树 —— CLI 的 `diy seed run` 不变；拆出去是为了将来整域搬进 pkg。
      seed: seedRoutes,

      facts: factsRoutes,
      kb: kbRoutes,

      docs: docsRoutes,

      journal: journalRoutes,

      flow: flowRoutes,

      /**
       * 后台 job（##408 v1：只有 spawned 型 —— 会话里跑出来的长时命令）：
       * 定义在哪（哪个任务/轮/工具调用）、跑了多久、怎么结束的、输出尾巴。
       *
       * **只读**：本刀不做「运行 / 停用 / 取消」（刀 6 起接），故没有 run/cancel 子命令。
       */
      job: jobRoutes,

      log: logRoutes,

      /**
       * Hub 配对（##500）：地址即身份 —— 人比对真实 URL，6 位码只管「谁被允许进来」。
       *
       * 协议真源 `docs/plans/2026-11-01-hub-pairing.md`。v1 只接受 tailscale 地址（可信 HTTPS），
       * 不做指纹核对 / SAS / 自签证书 pinning / mDNS 配对路径。
       *
       * 卫星侧分两步：`join <url>`（只显示要连接的地址，不发秘密）→ `join <url> --code`（提交申请）。
       */
      hub: hubRoutes,

      /**
       * 远程实例（##479 第一刀）：实例身份 + 四路 endpoint 发现 + `/ping`。
       *
       * ⚠️ **当前无鉴权**（本轮明确不做）：`/ping` 缺省只绑 127.0.0.1；跨机发现要显式
       * `DIY_PING_HOST=<内网 / tailscale 地址>`，**绝不要绑公网**（判据见 `remote/node/ping-server.ts`）。
       *
       * 判据 4：发现结果**合并去重后列出来选**，本域没有任何「自动连接 / 自动配对」入口。
       */
      remote: remoteRoutes,

      /**
       * 实例大盘（Main 域）——「本机现在有哪些 diy 实例在跑、各自是谁、在干什么」。
       *
       * 发现靠**扫进程**（没有实例索引，见 services/instances.ts 文件头），
       * 「谁开的」靠启动时写进注册表（`~/.diy-instances/<pid>.json`，事后再追父链追不出来），
       * 数据根/端口靠**活体自报**（环境变量是继承来的，不等于真根）。
       */
      instances: instancesRoutes,

      /**
       * 文件系统变更推送（Main 域）。
       *
       * ⚠️ 必须在 diy.* 而非 diy.ui.*：实现是 main 侧的 FileWatcher（renderer 只是订阅方），
       * 而 rpc-port 会把 `diy.ui` 整棵子树 onForward 给 renderer —— 挂在 ui 下会让同一方法
       * 被注册两次（本地 + 转发），ServerBinding 直接抛「已注册」使 RPC 服务器起不来。
       * 判据：diy.* = Main 本地处理，diy.ui.* = 转发 Renderer（见本文件头注释）。
       */
      watch: watchRoutes,

      /**
       * 「模型不可用」通知（##369 ①）。Main 本地域（判据在 main 侧：只有真发失败的那一刻
       * 才拿得到状态码与上游原文），renderer 订阅 `watch` 出顶栏 bar。
       *
       * 数据定性 = cache（进程内存 ring，重启即空）：它描述"此刻有什么坏了"，不是历史账；
       * 追溯去看会话流与 ~/.diy/log/network/*.jsonl。
       */
      notice: noticeRoutes,

      /**
       * 「环境感知」通知（##384）—— 机器环境坏了（磁盘满 / 网断）时推一条，renderer 订阅
       * `watch` 出顶栏红条。
       *
       * 与 `notice.*`（模型不可用，##369）的分工：那边看**上游语义**（模型挂没挂），这边看
       * **本地水位与错误码**（机器还能不能写、网还通不通）。两者都是"沉默的失败"，出口同一形态。
       *
       * 数据定性 = cache（进程内存 ring，重启即空）：描述"此刻环境怎么了"，不是历史账；
       * 追溯去看 `~/.diy/log/network/*.jsonl` 与会话流（`rule.core-log`）。
       *
       * **自动消**是硬要求：空间腾出来 / 网恢复 → 红条自己消失（`watch` 推 resolve 事件），
       * 不要用户手动关。`dismiss` 的语义是"这个条件我知道了"→ 静音该类，条件不变不再弹。
       */
      env: envRoutes,

      /**
       * 冷缓存提示（##477）—— 距上次请求太久、上游前缀缓存可能已过期时，顶栏出**一行**
       * 提示；用量面板的「缓存时效柱」也从这里取边界（safePoint / failPoint / 上次请求时刻）。
       *
       * 为什么是 main 域：判据要真发的**首步命中率**与请求时刻，只有 main 拿得到。
       * 数据定性 = store（`$DIY_HOME/cache-hint.yaml`，重启后仍是上次算出的边界）——
       * 与 notice/env 的内存 ring 不同：这里「没有失败记录」本身就是一条判据（不提示）。
       */
      cacheHint: cacheHintRoutes,

      // ═══════════════════════════════════════════
      //  diy.ui.* — Renderer 进程域
      //  这些服务只在 Renderer 进程（浏览器）中运行。Main 侧经
      //  Main 侧 onForward 转发到 Renderer；Renderer 侧直接本地处理。
      // ═══════════════════════════════════════════
      ui: uiRoutes,
    },
  }),
} });

/** `apiDef.diy` —— 各域 impl 取值起点（拆 impl 后各域都要它） */
export const app = apiDef.diy;

