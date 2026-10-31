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

// 任务状态枚举 — 单一真相源 task-state.ts（纯 zod，无 Node 依赖，浏览器安全） */
import { TaskStateSchema } from "../core/task-state";
import { ChangeTypeSchema, PrioritySchema } from "../core/task-fields";

const StatusDataUri = z.object({ status: z.string(), data: z.object({ uri: z.string() }) });

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
const StatusDataId = z.object({ status: z.string(), data: z.object({ id: z.string() }) });
const StatusOk = z.object({ status: z.string() });

const TrafficSnapshotSchema = z.object({
  fullCapture: z.boolean().describe("是否记录完整请求内容（正文不截断）"),
  cap: z.number().describe("内存里最多留多少条"),
  total: z.number(),
  logDir: z.string().describe("日志目录（相对 DIY_HOME）"),
  records: z.array(TrafficRecordSchema),
});

/** 任务树节点 schema（递归，供 ui.tree 输出强类型） */
/** UI 快照数据（ui.state 单读 / ui.watch.uiState 流 共用同一形状） */
const UiSnapshotData = z.object({
  rev: z.number().describe("UI 快照序号（每次渲染提交递增；通用屏障）"),
  uiRev: z.number().describe("本地 UI 状态版本（tab/页面/选中 变化递增）"),
  dataRev: z.number().describe("数据版本（任务树等来自 main 的数据变化递增；跨进程链的终点）"),
  active: z.string().describe('当前激活 tab key；"" = 任务管理页'),
  tabs: z.array(z.object({
    key: z.string(),
    pageId: z.string(),
    ctx: z.string().nullable(),
    indent: z.number().describe("任务层次缩进（祖先链长度）"),
  })),
  selectedUri: z.string().nullable().describe("任务树当前选中任务 uri"),
  tree: z.object({
    count: z.number().describe("任务数（递归展开任务节点后的数量）"),
    sig: z.string().describe("任务 uri+状态+标题 排序签名（消费端可比对，不需解析 DOM）"),
    loading: z.boolean(),
  }),
});

export interface TaskNodeShape {
  kind: "project" | "task";
  uri?: string;
  /** 任务号 = uri 末段（项目内自增）。列表默认按它对同级排序，故必须在契约里 */
  num?: string;
  title?: string;
  state?: string;
  project?: string;
  /** 项目路径/显示名（main 的 task-tree 回填；运行时输出一直有，类型此前漏了） */
  project_path?: string;
  project_label?: string;
  parentUri?: string;
  body?: string;
  created?: string;
  updated?: string;
  change_type?: string;
  module?: string;
  priority?: string;
  /**
   * 该任务**是否与 agent 对话过**（##355「干净任务」态；真源 = 会话 Op 日志存在且非空，
   * 见 core/local-paths.ts 的 hasConversation）。缺省 = 未算（旧载荷），读侧按"未知"处理。
   */
  has_session?: boolean;
  /** 该任务是否有**未发送的草稿**（##355「有草稿」态；真源 = 任务目录 .diy/drafts.yaml 的 agent_input） */
  has_draft?: boolean;
  children: TaskNodeShape[];
}
const TaskNodeSchema: z.ZodType<TaskNodeShape> = z.lazy(() =>
  z.object({
    kind: z.enum(["project", "task"]),
    uri: z.string().optional(),
    num: z.string().optional(),
    title: z.string().optional(),
    state: TaskStateSchema.optional(),
    project: z.string().optional(),
    project_path: z.string().optional(),
    project_label: z.string().optional(),
    parentUri: z.string().optional(),
    body: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    // 刻意用 z.string() 而非 task-fields 的枚举：读侧一律宽容（历史手写值如 priority: high
    // 不在词表内也要能显示出来），枚举校验只发生在写入侧（task.create / task.edit 的 input）。
    change_type: z.string().optional(),
    module: z.string().optional(),
    priority: z.string().optional(),
    // agent 面状态（##355）：两枚逐任务布尔（判据见 TaskNodeShape 上的注释）。
    // 与上面的字段同样 optional —— 读侧宽容，缺了只是"这一项不知道"，不是错误。
    has_session: z.boolean().optional(),
    has_draft: z.boolean().optional(),
    children: z.array(TaskNodeSchema),
  }),
);

// 草稿契约在 shared/task-detail.ts（单一真源，renderer 同源）；re-export 保持既有引用路径不变
export { DraftFieldSchema, DraftFieldsSchema, DraftsData, TaskDetailSchema };

/**
 * 插话项（对话中「插嘴」的待投递消息）。
 * 与草稿同文件同生命周期（任务目录 .diy/drafts.yaml 的 steers 字段），
 * 但语义是**队列**：FIFO，提交后等模型取走。两种模式**都是整批取走**（多条合并成同一批），
 * 差别只在投递点：next-step = 下一个模型步边界之前（本轮内生效）；next-turn = 本轮收尾后的下一轮开场。
 */
export const SteerItemSchema = z.object({
  id: z.string(),
  mode: z.enum(["next-step", "next-turn"]),
  text: z.string(),
  created: z.string(),
});

/** ── 工作流（##319）──────────────────────────────────────────────
 * 形状与 core/flow.ts 的视图一一对应。注意：**outputSchema 运行期不校验**（只用于类型推导，
 * 见 pit.rpc-output-schema），故这里写的是契约、不是闸门 —— 改 handler 出参时两边一起改。 */
/** 当前节点（hint 已经内核 `renderHint` 插值 —— 宿主不再自己拼字符串） */
const FlowNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  actor: z.string(),
  hint: z.string(),
});
/** 引擎通用渲染器 id —— **真源是内核 `define.ts` 的 `RENDERERS`**（schema 只是引用它，不复制清单） */
const FlowRendererSchema = z.enum(RENDERERS);
/** 一条出边：「卡在哪条边」的数据源 */
const FlowEdgeSchema = z.object({
  to: z.string(),
  toName: z.string(),
  kind: z.enum(["next", "bounce"]),
  when: z.string().nullable(),
});
/**
 * 节点产物的**展示链**（内核 `NodeDef.art`，##337）—— 声明「这一步的产物长什么样、翻给哪个渲染器」：
 * `raw` 是行业知道的产物形状（说明文本），`renderer` 是引擎九种通用渲染器之一（合法值真源 = 内核
 * `RENDERERS`），`plugin` 是宿主注册的 render 插件名（**给 null / 不给 = 直吃 raw**）。
 */
const FlowArtSchema = z.object({
  raw: z.string().describe("该节点产物的形状说明（raw 长什么样；行业自己知道）"),
  renderer: FlowRendererSchema,
  plugin: z.string().nullable().optional().describe("宿主 render 插件名（`diy flow view` 用的就是它）；空 = 直吃 raw（只在 raw 本身已是该 renderer 的 data 时才合法）"),
  note: z.string().optional(),
});

/** 一份**译好**的产物视图（内核 `View`）：renderer + 给它的 payload（宿主**原样透传**，不校验形状） */
const FlowPayloadViewSchema = z.object({
  renderer: FlowRendererSchema,
  payload: z.any().describe("给该渲染器的数据（形状由 renderer 约定；宿主原样透传 —— 收窄归 UI）"),
  note: z.string().optional(),
});

/** 折线上一次驻留（领域事实：node/seq/kind/at + 宿主关联 ref） */
const FlowVisitSchema = z.object({
  node: z.string(),
  seq: z.number(),
  kind: z.enum(["next", "bounce"]),
  at: z.string(),
  ref: z.record(z.string(), z.string()).optional(),
});
/** 实例视图（show / start / advance / bounce / params.set 同一份回执形状） */
const FlowViewSchema = z.object({
  uri: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  entry: z.string(),
  entered: z.boolean(),
  position: z.string().nullable(),
  node: FlowNodeSchema.nullable(),
  done: z.boolean().describe(
    "工作流是否已跑完（领域事实 FlowState.done）：本版唯一来源是 `diy flow finish`（宣布收尾）—— 节点 guard 全是 prompt:，内核 step 的终态分支走不到",
  ),
  bounces: z.number(),
  next: z.object({
    mode: z
      .enum(["entry", "system", "actor"])
      .describe("下一手是谁：entry=尚未进入，actor=等人宣布。system（系统自动推）本版不会出现 —— 它要有 pred:/action: 插件，本版 guard 全是 prompt:"),
    pending: z.array(z.string()).describe("不可观测（prompt:）的 guard —— 等人宣布，系统判不了"),
    edges: z.array(FlowEdgeSchema),
    terminal: z
      .boolean()
      .describe("结构事实：已进入且当前位置没有 next 出边 ⇒ 往前无路可走（bounce 边不算下一步）。与内核 execute.ts 的 done 判据同一条结构事实"),
  }),
  art: FlowArtSchema.nullable().describe("当前节点声明的产物展示链（未进入 / 没声明 ⇒ null）"),
  view: FlowPayloadViewSchema.nullable().describe(
    "当前节点**当前驻留**的产物经 render 插件翻译后的结果（该驻留没放产物 ⇒ null —— 产物不是领域态，缺项是正常态）",
  ),
  viewError: z
    .string()
    .nullable()
    .describe(
      "产物路的错误位（null = 没出错）：袋不是合法 JSON / 不是数组 / 声明与翻译不一致时**不阻断本命令**（view 仍为 null，位置与折线照常）—— 产物是派生数据，不许拖垮领域读；要亮错用 `diy flow view`",
    ),
  trajectory: z.array(FlowVisitSchema),
  params: z.record(z.string(), z.any()).describe("L2 参数值（权威 = 任务目录 flow/state.json）"),
  paramsSchema: z.array(z.any()).describe("参数声明（内核 paramsOf 的 schema，供表单/文档渲染）"),
  files: z.object({
    dir: z.string(),
    instance: z.string(),
    state: z.string(),
    path: z.string(),
    events: z.string(),
    threads: z.string().describe("讨论流（##342）：旁注，可清可丢（删了不影响推进，只是线程里的发言没了）"),
  }),
  auditSkipped: z.number().describe("审计流里跳过（解析失败）的行数 —— 审计坏了只报数，不阻断运行"),
  threadError: z
    .string()
    .nullable()
    .describe(
      "讨论流的错误位（null = 旁注没出错）：坏行 / 读不出时**不阻断本命令**（位置 / 折线 / 参数照常）—— 讨论是旁注，不许拖垮领域读；要看讨论流本身用 `flow thread list`",
    ),
});

/** 一份产物视图（`diy flow view` / `flow artifact put` 的回执；形状与 core/flow.ts 的 `FlowArtifactView` 一致） */
const FlowArtifactViewSchema = z.object({
  uri: z.string(),
  node: z.string(),
  nodeName: z.string(),
  seq: z.number().describe("目标驻留序号（1-based = 折线上该节点第几次驻留）"),
  art: FlowArtSchema.nullable().describe("该节点声明的展示链（没声明 ⇒ null）"),
  plugin: z.string().nullable().describe("实际用到的 render 插件名（null = 直吃 raw / 没声明 art）"),
  view: FlowPayloadViewSchema.nullable().describe("翻译结果；该驻留没有产物 ⇒ null"),
  bag: z.string().describe("产物袋文件（不存在也是正常态：产物不是领域态）"),
});

/**
 * 讨论线程（##342）：一条发言 + 一条线程（锚点 = 一次**真打回边**的穿越）。
 *
 * 形状与 `core/flow-store.ts` 的 `FlowPost` / `core/flow-thread.ts` 的 `FlowThreadView` 一一对应。
 * 锚点 `{from,to,seq}`：`from` = 打回前位置、`to` = 落点节点、`seq` = **落点那次驻留**的序号
 * （一次 bounce 恰创生一次驻留 ⇒ 三元组唯一；同节点二次打回各是各的）。
 */
const FlowAnchorSchema = z.object({
  from: z.string().describe("打回前所在节点"),
  to: z.string().describe("打回落点节点"),
  seq: z.number().describe("落点那次驻留的序号（Visit.seq）—— 同一节点二次打回靠它区分，不串台"),
});
const FlowPostSchema = z.object({
  id: z.string(),
  at: z.string(),
  author: z.string().describe("谁说的：cli（人敲） / agent 标识（驱动环起的轮次） / human"),
  type: z.enum(["note", "resolved", "escalate"]).describe("note=发言（含自动打回的意见正文）/ resolved=宣布线程已解决 / escalate=升级人裁决"),
  anchor: FlowAnchorSchema,
  text: z.string(),
});
const FlowThreadSchema = z.object({
  id: z.string().describe("线程 id，文本形 `<打回源节点>-><落点节点>#<落点驻留序号>`（`--thread` 参数就是它）"),
  anchor: FlowAnchorSchema,
  fromName: z.string(),
  toName: z.string(),
  fromSeq: z.number().nullable().describe("打回源那次驻留的序号（从折线推；假锚点 ⇒ null）"),
  real: z
    .boolean()
    .describe("折线上**确有**这条打回边（false = 讨论流里有、折线上查无 ⇒ 假数据，亮出来而不是藏起来）"),
  at: z.number().describe("折线上的次序（第几次位置变更；假锚点 ⇒ -1）"),
  status: z.enum(["open", "resolved", "escalated"]).describe("由最后一条状态发言推；没有状态发言 ⇒ open"),
  posts: z.array(FlowPostSchema),
});
/** `flow thread list` / `flow thread post` 的载荷（同一份形状：post 回执顺手把新表带回来，UI 不必再调一次） */
const FlowThreadsSchema = z.object({
  uri: z.string(),
  threads: z.array(FlowThreadSchema),
  skipped: z.number().describe("讨论流里跳过（读不出 / 形状不符）的行数 —— 旁注可坏，坏了只报数"),
  error: z.string().nullable().describe("讨论流的错误位（null = 没出错）：读不出 / 有坏行时也不外抛"),
  file: z.string().describe("讨论流文件（不存在也是正常态：还没人发过言）"),
});

/**
 * 「多个 `k=v`」型 CLI 入参：JSON 数组（与既有 array 选项同形，parser 会 JSON.parse）或单个裸值。
 *
 * ⚠️ 必须是**工厂**不是共享常量：`cliOption` 的元数据注册在 `_unwrap()`（剥掉 optional 后的那层）上，
 * 共用一个 schema 对象会让后注册的 desc 覆盖前面每个使用点（help 文案串台）。
 */
const kvList = () => z.union([z.string(), z.array(z.string())]);

export const apiDef = RpcSchema.router({
  diy: RpcSchema.group({
    desc: `
    diy 管控台 CLI
    管控台命令行工具，提供任务管理、主题管理、Agent 对话、LLM 代理、日志查看等功能。
    `,
    children: {
      task: RpcSchema.group({
        desc: `任务管理`,
        children: {
          create: RpcSchema.unary({
            desc: `
            创建任务

            正文（body）输入契约（##338 / ##376）—— **三选一**，同时给多个会被拒（不猜、不按顺序取）：
              \`--body <文本>\`        任务内容（内联正文；值形如**单行文件路径** → 直接报错并提示正确写法）
              \`--body-text <文本>\`   任务内容（显式内联文本：与 \`--body\` 同义，但不做「形如路径」护栏）
              \`--body-file <file|->\` 任务内容：从**文件**读（\`-\` = stdin；相对路径按当前目录解析）
            与 \`task edit\` 同一套选项形状与同一条裁决（\`core/task.ts::resolveBodyOverride\`）。
            注意：create 是新建任务，**不做「整份任务文件剥头」**（没头可覆盖），传整份文件会把头写进正文。

            归属检测（##430）：cwd 落在**另一个** project 的目录（含其 worktree）里 ⇒ 直接拒绝并列出候选
            （多项目各自自增、同号会撞车，事后很难发现）。确要在那个 project 下建 → 显式加 \`--force\`。
            成功时回显 uri + project + label + path（只回 uri 时看不出落到了哪个仓）。
            `,
            input: {
              title: z.string().min(1, "标题不能为空").max(200).cliArg({ desc: "任务标题" }),
              project: z.string().cliArg({ desc: "所属 project id" }),
              parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
              body: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<text>",
                  inlineText: { fileOpt: "--body-file", textOpt: "--body-text" },
                  desc: "任务内容（**内联正文**，不是文件路径：值形如单行路径会被拒）",
                }),
              bodyText: z
                .string()
                .optional()
                .cliOption({ placeholder: "<text>", desc: "任务内容（显式内联文本：与 `--body` 同义，但不做「形如路径」护栏）" }),
              bodyFile: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<file|->",
                  readFile: true,
                  desc: "任务内容：从**文件**读（`-` = stdin；相对路径按当前目录解析）—— **不剥 frontmatter**（新建任务无头可覆盖，传整份文件会把头写进正文）",
                }),
              persona: z.string().optional().cliOption({ desc: "agent 人物 id（不传 = 跟随缺省；传值 = 固定绑定，人物决定模型/参数/行为指令）" }),
              change_type: ChangeTypeSchema.optional().cliOption({ desc: "变更性质（feat/fix/docs/…，见 conventional commits）" }),
              module: z.string().optional().cliOption({ desc: "模块（可 `/` 分层，如 agent/ui）" }),
              priority: PrioritySchema.optional().cliOption({ desc: "优先级 P0-P3（不传=未定级）" }),
              /** 调用方 cwd（parser 自动注入，不是可敲的选项）—— 归属检测用（见 api-impl 的 task.create）。 */
              cwd: z.string().optional().cliOption({ callerCwd: true }),
              /** 归属检测的逃生口：确知要在「cwd 所在项目之外」建任务时显式声明。 */
              force: z
                .boolean()
                .optional()
                .cliOption({
                  desc: "跳过「cwd 归属不符」的拦截（确要在别的项目下建任务时用；默认会拒绝并要求改 --project）",
                }),
            },
            output: CreateResult,
          }),
          list: RpcSchema.unary({
            desc: `列出任务`,
            input: {
              project: z.string().optional().cliOption({ short: "p", desc: "按 project 筛选" }),
            },
            output: z.object({
              status: z.string(),
              data: z.object({
                /** 任务 URI 列表（形状不变：`string[]`；细分信息在 `projects` 里） */
                tasks: z.any(),
                /** 结果涉及到的 project 归属（id → label/path）：多项目同号时靠它区分（##430） */
                projects: z
                  .array(z.object({ id: z.string(), label: z.string().optional(), path: z.string().optional() }))
                  .optional(),
              }),
            }),
          }),
          show: RpcSchema.unary({
            desc: `查看任务详情（含未提交草稿 ui_drafts）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),

          /** 半编辑草稿：用户未提交的输入（agent 输入框 / 任务编辑框），落任务目录 .diy/drafts.yaml */
          drafts: RpcSchema.group({
            desc: `未提交草稿（agent 输入 / 任务编辑框；落任务目录 .diy/drafts.yaml）`,
            children: {
              show: RpcSchema.unary({
                desc: `读取任务的未提交草稿（无草稿时 data 为 null）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.object({ status: z.string(), data: DraftsData.nullable() }),
              }),
              set: RpcSchema.unary({
                desc: `
                写入草稿（合并语义：只覆盖传入的字段）

                字段按白名单平铺，不用 JSON 参数：白名单固定且短，平铺后 --help 逐字段可见，
                也免去 shell 里 JSON 引号的层层转义。传空字符串（如 --title ""）= 清除该字段；
                不传 = 保持原值。已提交（保存/取消）后应显式清除，否则草稿会盖住新数据。

                正文草稿（body）与 \`task edit\` 同一套输入契约（##338 / ##376）—— **三选一**：
                  \`--body <文本>\`        内容草稿（内联正文；值形如**单行文件路径** → 直接报错）
                  \`--body-text <文本>\`   内容草稿（显式内联文本：不做「形如路径」护栏）
                  \`--body-file <file|->\` 内容草稿：从**文件**读（\`-\` = stdin）
                `,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                  title: z.string().optional().cliOption({ desc: "标题草稿（空串=清除）" }),
                  body: z
                    .string()
                    .optional()
                    .cliOption({
                      placeholder: "<text>",
                      inlineText: { fileOpt: "--body-file", textOpt: "--body-text" },
                      desc: "内容草稿（空串=清除；**内联正文**，不是文件路径：值形如单行路径会被拒）",
                    }),
                  bodyText: z
                    .string()
                    .optional()
                    .cliOption({ placeholder: "<text>", desc: "内容草稿（显式内联文本：与 `--body` 同义，但不做「形如路径」护栏）" }),
                  bodyFile: z
                    .string()
                    .optional()
                    .cliOption({
                      placeholder: "<file|->",
                      readFile: true,
                      desc: "内容草稿：从**文件**读（`-` = stdin；相对路径按当前目录解析）",
                    }),
                  agent_input: z.string().optional().cliOption({ desc: "agent 输入框草稿（空串=清除）" }),
                  base_updated: z.string().optional().cliOption({ desc: "草稿基点：任务当前 updated（用于检测过期）" }),
                },
                output: z.object({ status: z.string(), data: DraftsData }),
              }),
              clear: RpcSchema.unary({
                desc: `清除草稿字段（不传 fields 清空全部字段；传 [] 什么都不清。只动草稿字段，不动待投递的插话队列；文件在字段与队列都空时才删除）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                  // CLI 数组统一走 JSON 形式（parser 只对 ZodArray 做 JSON.parse）：
                  // 必须写 --fields '["title"]'，写 --fields title 会得到 "expected array"。renderer 侧传数组。
                  fields: z.array(DraftFieldSchema).optional().cliOption({ desc: `只清指定字段（JSON 数组，如 '[\"title\"]'）` }),
                },
                output: StatusOk,
              }),
            },
          }),
          edit: RpcSchema.unary({
            desc: `
            编辑任务

            正文（body）输入契约（##322 / ##338）—— **整篇覆盖三选一、追加三选一**，同时给多个会被拒
            （不猜、不按顺序取）：
              \`--body <文本>\`        整篇覆盖（内联正文；值形如**单行文件路径** → 直接报错并提示正确写法）
              \`--body-text <文本>\`   整篇覆盖（显式内联文本，不做路径护栏 —— 正文本身就是一行路径时用它）
              \`--body-file <file|->\` 整篇覆盖（从文件读，\`-\` = stdin；等价 \`--body "$(cat f)"\`，但不受 ARG_MAX 限制）
              \`--append-body\` / \`--append-body-file\` / \`--append-body-text\`：追加的同样三态。
            为什么把"传文件"和"传文本"分开：在此之前 \`--body\` 只收文本，而 \`--append-body\` 收 \`<file|->\` ——
            两侧不对称，直觉上"都是传文件"，于是 \`diy task edit X --body /tmp/x.md\` 把**路径串当正文静默存下**、
            原正文丢失且无告警（##290 / ##294 / ##87 三例现场）。

            两者都接受"整份任务文件"（frontmatter + 正文）作输入：头会被**剥离**后丢弃（文件头才是权威），
            在返回值里回报剥了哪些键与**被剥掉的原文** —— 于是 \`--body "$(cat AGENTS.md)"\` 不再产生双头。
            判据不对称：\`--append-body\` 更严（追加一份"带 front matter 的文档"是常态，只认已知键会把
            文档头的 \`title:\` 当成任务头吞掉）。
            `,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              title: z.string().optional().cliOption({ short: "t", desc: "新标题" }),
              state: TaskStateSchema.optional().cliOption({ desc: "新状态" }),
              body: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<text>",
                  inlineText: { fileOpt: "--body-file", textOpt: "--body-text" },
                  desc: "新内容，整篇覆盖（**内联正文**，不是文件路径：值形如单行路径会被拒；至少 10 字符；传整份文件自动剥头）",
                }),
              bodyText: z
                .string()
                .optional()
                .cliOption({ placeholder: "<text>", desc: "新内容，整篇覆盖（显式内联文本：与 `--body` 同义，但不做「形如路径」护栏）" }),
              bodyFile: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<file|->",
                  readFile: true,
                  desc: "新内容，整篇覆盖：从**文件**读（`-` = stdin；相对路径按当前目录解析；传整份文件自动剥头）",
                }),
              appendBody: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<file|->",
                  readFile: true,
                  desc: "追加内容：文件路径（相对路径按当前目录解析），`-` 读 stdin。追加在原正文之后（空行分隔），不必先读任务文件（= `--append-body-file`）",
                }),
              appendBodyFile: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<file|->",
                  readFile: true,
                  desc: "追加内容：文件路径（`-` = stdin）—— 与 `--append-body` 同义，是同一件事的显式名",
                }),
              appendBodyText: z
                .string()
                .optional()
                .cliOption({ placeholder: "<text>", desc: "追加内容：**内联文本**（`--append-body` 的对称项：追加也能直接给文本，不必先落盘）" }),
              parent: z.string().optional().cliOption({ desc: "父任务 URI（空字符串=取消父子关系）" }),
              // 三态：不传=保持原绑定 / `default`（或空串）=**跟随缺省**（取消固定绑定）/ 值=换绑到该人物。
              // 换绑是续聊（会话与上下文不动），新模型**下一轮**生效。
              persona: z
                .string()
                .optional()
                .cliOption({ desc: "agent 人物 id（不传=保持；default=跟随缺省；值=固定绑定，模型下一轮生效）" }),
              change_type: z.string().optional().cliOption({ desc: "变更性质（feat/fix/…；空字符串=清除）" }),
              module: z.string().optional().cliOption({ desc: "模块（空字符串=清除）" }),
              priority: z.string().optional().cliOption({ desc: "优先级 P0-P3（空字符串=清除回未定级）" }),
            },
            output: StatusDataTaskWrite,
          }),
          move: RpcSchema.unary({
            desc: `移动任务（改变父级）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              parent: z.string().cliArg({ desc: "新父任务 URI（空字符串=取消父子关系）" }),
            },
            output: StatusDataUri,
          }),
          delete: RpcSchema.unary({
            desc: `删除任务`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: StatusDataUri,
          }),
        },
      }),

      project: RpcSchema.group({
        desc: `项目管理`,
        children: {
          create: RpcSchema.unary({
            desc: `创建项目（path 必填，id 自动生成并返回 {id}）`,
            input: {
              path: z.string().min(1, "path 不能为空").cliArg({ desc: "项目路径（映射到该目录下的 diy.yaml）" }),
              label: z.string().optional().cliOption({ short: "l", desc: "显示名称" }),
              desc: z.string().optional().cliOption({ desc: "描述" }),
              state: z.string().optional().cliOption({ desc: "状态" }),
            },
            output: StatusDataId,
          }),
          list: RpcSchema.unary({
            desc: `列出项目`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                projects: z.array(
                  z.object({
                    id: z.string(),
                    info: z.object({
                      label: z.string().optional(),
                      path: z.string().optional(),
                      desc: z.string().optional(),
                      state: z.string().optional(),
                    }),
                  }),
                ),
              }),
            }),
          }),
          remove: RpcSchema.unary({
            desc: `删除项目`,
            input: {
              id: z.string().cliArg({ desc: "project id" }),
            },
            output: StatusDataId,
          }),
        },
      }),

      /** Main 进程运行状态（供 renderer diy.ui.status 反向调用） */
      getAppStatus: RpcSchema.unary({
        desc: `主进程运行状态（pid/uptime/memory）`,
        input: {},
        output: z.object({
          status: z.string(),
          data: z.object({
            pid: z.number(),
            uptime: z.number(),
            memory: z.number(),
          }),
        }),
      }),

      // 运行环境详情：设置页「状态」标签用，同时天然可被 CLI 调用。
      // 历史上它只是一条 ipcMain.handle("getAppInfo")，preload 没桥接、api-def 也没登记，
      // 于是 Electron 里 window.diy 为 undefined（可选链短路，永远卡在「加载中…」）、
      // serve 里方法不存在。走 RPC 后三种入口共用同一实现。
      getAppInfo: RpcSchema.unary({
        desc: `查询运行环境详情（端口/目录/版本/系统/CDP 连接地址）`,
        input: {},
        output: z.object({
          port: z.number(),
          diyHome: z.string(),
          /** 数据根的展示形式（相对**真实家目录**缩 `~`；隔离/临时根保持绝对路径）。
           *  窗口标题与界面展示用 —— renderer 拿不到真实家目录，缩写规则只能由 main 侧算
           *  （见 shared/instance-title 的 abbrevHome + main/core/instance-identity.ts）。 */
          diyHomeDisplay: z.string(),
          /** 当前代码仓库/ worktree 的展示路径（窗口标题用） */
          repoDisplay: z.string(),
          /** 运行环境（production/development/test）。dev/test 的界面与生产几乎一样，
           *  必须能看出来，否则容易误改生产数据。 */
          env: z.string(),
          /** 当前运行代码所在 git 分支（打包/非仓库为空串）。窗口标题用它区分
           *  「哪个 worktree 的构建」—— 数据根是 /tmp 或 build/<v>/home 时这是唯一来源线索。 */
          branch: z.string(),
          cache: z.string(),
          userData: z.string(),
          /** CDP 连接地址（`ws://127.0.0.1:<port>/devtools/browser/...`）—— 供
           *  `playwright-cli attach --cdp=<它>` 驱动真实窗口（设置页「复制调试信息」用）。
           *  Electron 以 `--remote-debugging-port=0` 启动时端口写在 userData/DevToolsActivePort；
           *  未启用 CDP / 文件不在（serve 模式）时为空串，不编造。 */
          cdp: z.string(),
          electron: z.string(),
          node: z.string(),
          chrome: z.string(),
          platform: z.string(),
          pid: z.number(),
          memory: z.string(),
        }),
      }),

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

      loadTaskTree: RpcSchema.unary({
        desc: `加载任务树（供 renderer 反向调用）`,
        input: {},
        output: z.object({ status: z.string(), data: z.array(TaskNodeSchema) }),
      }),

      getTask: RpcSchema.unary({
        desc: `按 URI 获取任务（供 renderer 反向调用；未找到时 data 为 null）`,
        // cliArg：不给它的话 `diy getTask <uri>` 完全没法从命令行调（"Unknown option"），
        // 于是这条 RPC 的载荷**只能靠跑 Electron 才能验证** —— 契约漏字段的 bug 就更容易溜过。
        input: { uri: z.string().cliArg({ desc: "任务 URI" }) },
        // 字段清单**不在此处手抄**：契约是 shared/task-detail.ts 的 TaskDetailSchema（单一真源，
        // renderer 的 TaskDetail 类型也从它推导）—— 加字段只改那一处。
        // 背景（此前的真实缺陷）：这里与 api-impl 的 handler **两处各抄一份**，漏一处就静默丢字段
        // （zod .object() 默认 strip 未声明键，实测漏过 change_type / module / priority / persona：
        //  renderer 拿到 undefined、详情面板显示"未设置"，而数据其实好好的）。那份手抄已被 167 取代。
        output: z.object({
          status: z.string(),
          // 未找到 → data: null，renderer 侧 `if (r.data)` 守卫才能生效
          data: TaskDetailSchema.nullable(),
        }),
      }),

      /** 弹出原生目录选择器（供 renderer「选择目录」按钮反向调用；Web/serve 模式无 Electron dialog 时返回 canceled） */
      pickProjectDirectory: RpcSchema.unary({
        desc: `弹出原生目录选择器，返回所选路径`,
        input: {},
        output: z.object({
          status: z.string(),
          data: z.object({
            canceled: z.boolean(),
            path: z.string().optional(),
          }),
        }),
      }),

      agent: RpcSchema.group({
        desc: `Agent 管理`,
        children: {

          // —— 本地自定义 agent（ai-sdk 块协议，独立于 ACP 通道）——
          // —— agent 人物（persona）——
          // 人物是**配置实体**：模型/参数/行为指令挂在这里，会话只持有引用（任务 frontmatter 的 persona）。
          // 于是「改人物」= 所有引用它的任务下一轮统一生效；「换人物」= 只改本任务的绑定，不碰别人。
          persona: RpcSchema.group({
            desc: `agent 人物（模型 + 参数 + 行为指令）；任务持**引用（id）**，改人物对使用它的会话下一轮生效`,
            children: {
              list: RpcSchema.unary({
                desc: `列出全部人物与缺省人物（含各人物被多少任务引用）`,
                input: {},
                output: z.object({
                  default: z.string().describe("缺省人物 id（跟随缺省的任务用它）"),
                  // taskCount = 引用面：改人物前必须先看见"会影响多少任务"（否则"统一修改"是盲改）
                  personas: z.array(PersonaSchema.extend({ taskCount: z.number() })),
                  // followCount = **跟随缺省**的任务数（不写 persona 键，故不计入任何人的 taskCount）。
                  // 改缺省影响的就是这批任务 —— 不给这个数，缺省人物在面板上会显示"暂无任务在用"。
                  followCount: z.number().describe("跟随缺省的任务数（改缺省会影响它们）"),
                }),
              }),
              set: RpcSchema.unary({
                desc: `新建人物（不传 id）或更新人物（传 id）；未给的字段保持原值`,
                input: {
                  // 位置参数（可省略）：`diy agent persona set p3 --model …` 更新，不传 = 新建。
                  // 位置参数给 id 而不是名字：脚本/自动化要的是稳定键；人按名字用 --name。
                  id: z.string().optional().cliArg({ desc: "人物 id（更新时给；不传 = 新建人物）" }),
                  name: z.string().optional().cliOption({ desc: "显示名（可改，引用不受影响）" }),
                  model: z.string().optional().cliOption({ desc: "模型 id（见 agent local models；新建时必填）" }),
                  reasoningEffort: z
                    .string()
                    .optional()
                    .cliOption({ desc: "推理强度档位（按该模型支持集，见 agent local models）" }),
                  instructions: z.string().optional().cliOption({ desc: `行为指令（注入身份节；空串=不注入）` }),
                },
                output: PersonaSchema,
              }),
              setDefault: RpcSchema.unary({
                desc: `设置缺省人物（只影响之后**新建**的任务，已有任务的绑定不变）`,
                input: {
                  id: z.string().cliArg({ desc: "人物 id（或显示名）" }),
                },
                output: z.object({ default: z.string() }),
              }),
              // 暂不提供 remove：人物的价值是"可复用的配置实体"，删掉它所有引用者会静默回落缺省
              // （换模型不打招呼）。要下线一个人物，改它的模型/行为指令即可（引用者原地跟随）；
              // 真需要删除时再设计"引用迁移"（改绑 N 个任务）一起做，不做半截的删除。
            },
          }),

          local: RpcSchema.group({
            desc: `本地自定义 agent（ai-sdk，独立于 ACP 通道）`,
            children: {
              chat: RpcSchema.serverStream({
                desc: `本地 agent 对话 — 实时逐行输出块协议 Op（JSONL）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  message: z.string().cliArg({ desc: "用户消息" }),
                  mode: z
                    .enum(["next-step", "next-turn"])
                    .optional()
                    .cliOption({
                      desc: "给出则把消息入队（next-step=下一个模型步前生效；next-turn=本轮收尾后的下一轮开场；两者都整批投；**该任务没有轮次在跑时，入队即用队列开一轮发出**）；省略则立即开一轮",
                    }),
                  // 下面两项是**临时覆盖**，不写配置：模型/参数的真源是任务绑定的人物
                  // （diy agent persona …）。UI 不传，留着是给 CLI/调试临时试模型用。
                  model: z.string().optional().cliOption({ desc: `临时覆盖模型（缺省 = 任务当前人物的模型）` }),
                  reasoningEffort: z.string().optional().cliOption({ desc: "临时覆盖推理强度（缺省 = 人物配置）" }),
                  author: z
                    .string()
                    .optional()
                    .cliOption({
                      desc: "发言者署名（成员 id，如 agent:166 / human:ccc）—— 落该条 user 块 meta.author；省略 = 本任务本人（##166 §40 A）",
                    }),
                },
                output: z.string(),
              }),
              cancel: RpcSchema.unary({
                desc: `中断本地 agent 当前生成`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.object({ cancelled: z.boolean() }),
              }),
              /**
               * **发送前门禁**（##426 B）：这一条用户消息有多长、要花多少钱、窗口占多少。
               *
               * 为什么放在 main：token 估算 / 单价快照 / 窗口占用三件事的真源都在主进程
               * （`shared/context/input-limit.ts` 纯算术 + `usage.jsonl` 最后一步实测 + 模型价目），
               * 渲染层各算一份必然与账本对不上（"UI 说 $0.03、账本写 $0.0303"那种不可信的数）。
               *
               * 判据只看**本条消息**：`over=false` 时 UI 必须零变化（不弹、不闪、不改文案）。
               */
              inputGate: RpcSchema.unary({
                desc: `量一条待发用户消息：字符数 / 估算 token / 成本增量 / 窗口占用（超阈值 → UI 弹门禁框）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  text: z.string().cliArg({ desc: "待发消息原文（只量不发）" }),
                },
                output: z.object({
                  over: z.boolean().describe("超过 inputLimitChars（唯一判据）"),
                  chars: z.number().describe("字符数（code point 口径）"),
                  bytes: z.number().describe("UTF-8 字节数"),
                  estTokens: z.number().describe("粗略 token（字节 / 4，与全仓同口径）"),
                  limitChars: z.number().describe("当前阈值（$DIY_HOME/context.yaml 的 inputLimitChars）"),
                  costIncrement: z.number().nullable().describe("预计成本增量（$）；无价目 = null，不画 0"),
                  windowTokens: z.number().nullable().describe("当前窗口占用（最后一步总输入+总输出）"),
                  contextLimitTokens: z.number().nullable().describe("模型上下文窗口；未知 = null"),
                  windowRatio: z.number().nullable().describe("加上本条后的窗口占用率（0~1+）；窗口未知 = null"),
                }),
              }),
              /**
               * **转文件发送**（##426 B 的「转文件」动作）：把超长内容落
               * `$DIY_HOME/<taskUri>/gen/paste/<ts>.txt`，返回消息体（路径 + 前 20 行 + 总行数/字节数）。
               * 只落文件、不发送 —— 发送仍由调用方走原通道（这样"转文件"与"真发"各自可测）。
               */
              pasteToFile: RpcSchema.unary({
                desc: `把超长消息正文存成任务目录下的文件，返回可发送的消息体（路径 + 前 20 行 + 总行数/字节数）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  text: z.string().cliArg({ desc: "要转存的消息原文" }),
                },
                output: z.object({
                  path: z.string().describe("落盘路径（绝对路径）"),
                  message: z.string().describe("替换原消息的文字（路径 + 前 20 行 + 总行数/字节数）"),
                }),
              }),
              /**
               * 运行态真值查询：renderer 的私有 `running` 只表示"我这轮在等自己的流"，
               * 回答不了「别人（CLI/另一窗口）是否正在这个任务上跑」。
               * 真相在**会话注册表**里（`session-registry` 的 `turn != null` 条目；`runtime-context.activeTurnList`
               * 是它的投影读口，##240 review1 P2-3 收敛）：
               * 把它查出来，UI 才不会把别人正在跑的轮次误判成「流中断」，也才谈得上给它一个停止入口。
               * 深度字段（steps / tokens / queue / viewers / lastEndReason）见 `sessions`。
               */
              running: RpcSchema.unary({
                desc: `列出此刻真正在跑的本地 agent 轮次（主进程内存权威；UI 判「直播中/可停止」用它，不靠日志猜）`,
                input: {},
                output: z.object({
                  active: z.array(
                    z.object({
                      taskUri: z.string(),
                      model: z.string().optional(),
                      cwd: z.string().optional(),
                      since: z.string().describe("轮次起始 ISO 时间"),
                      // ##305：无订阅者（detached）的活跃轮次也如实列出 —— 它是 [5] ##308 的数据源。
                      // 0 = 此刻没人看（UI 都退订了），轮次仍在跑；开销由 maxSteps 步数上限收口。
                      subscribers: z.number().describe("此刻观察该会话的订阅者数（chat 流 + op 订阅）"),
                    }),
                  ),
                }),
              }),
              /**
               * **一轮的进度**（**形式无关**的读口；owner ##166 第三轮口径第 2 条）。
               *
               * 口径原话：给 `(memberUri, turnId)` 返回该轮的进度块流，「供 UI 渲染，且能复用任务对话那套」。
               * 这里以 **taskUri** 为键 —— `memberUri` 是 room 侧的叫法（成员表负责映射），
               * 读口本身**不绑 room**：五种「多 session 观察」布局、任务对话页、CLI 都吃同一份。
               *
               * 与 `room.turn` 的分工：那条是 room 的**便利口**（按事件 id 取，省得调用方自己查 ref），
               * 这条是底座（任何持有 (会话, 轮次) 的消费方都能取）。
               */
              turn: RpcSchema.unary({
                desc: `取某个会话某一轮的进度：块流 + L1 状态（在跑吗 / 在做什么 / 第几步）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI（= 会话）" }),
                  turnId: z.string().cliArg({ desc: "轮次 id（如 t1792252594279；事件 ref 或会话流里给）" }),
                },
                output: z.object({
                  taskUri: z.string(),
                  turnId: z.string(),
                  /** 该轮的块树（找不到 = null：会话被清空 / 被 compact / turnId 写错） */
                  turn: z.any().nullable(),
                  /** 该会话此刻是否有轮次在跑（会话注册表口径，不靠日志猜） */
                  live: z.boolean(),
                  /** 会话注册表条目（L1 真源：steps / tokens / startedAt / state / viewers / queue / lastEndReason） */
                  entry: z.any().nullable(),
                  /** 此刻在干什么（未闭合块的判据；空闲 = null） */
                  action: z.object({ kind: z.string(), label: z.string() }).nullable(),
                  /** 服务端时刻（epoch ms）：「已用时长」的基准，别用消费端时钟 */
                  now: z.number(),
                }),
              }),
              history: RpcSchema.unary({
                desc: `读取本地 agent 会话的块协议 Op 日志（UI 重放用；返回**折叠后**的等价流，大会话快路径）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.array(z.any()),
              }),
              // ─── 大会话分页（任务 293）─────────────────────────────
              // 与上面的 `history` **并存而不替换**：`history` = 全量、始终全量的语义，
              // CLI（`agent local history`）与意图测试都钉着它；分页是**渲染端专用**的通路
              // （窗口边界只有 UI 用得上，命令行拿一整份更合手）。
              /** 最近一段（首载）／同一段的重取（轮末刷新，带 cursor） */
              historyWindow: RpcSchema.unary({
                desc: `读取本地 agent 会话的**最近一段** Op 流（按字节预算向上 seek 轮首；带游标 = 从该段起点重取）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  /** 窗口字节预算（首载用；带 cursor 时忽略）。缺省 0 = 全量 */
                  budgetBytes: z
                    .number()
                    .optional()
                    .cliOption({ desc: "窗口字节预算（缺省 0 = 全量）；带 --cursor 时忽略" }),
                  /** 段起点游标（main 签发的不透明 token）；只回传，不解释 */
                  cursor: z
                    .string()
                    .optional()
                    .cliOption({ desc: "上一次返回的游标（= 从该段起点重取）；失效则退全量" }),
                },
                output: z.object({
                  ops: z.array(z.any()),
                  cursor: z.string(),
                  hasMore: z.boolean(),
                  /** 游标失效 ⇒ 本次是退化全量（渲染端必须重置现有段，不能当前缀拼） */
                  stale: z.boolean(),
                  /**
                   * 降级重建标记（##424 刀 2）：有它 = `ops` 不是 ops 原文，而是 `turns.jsonl`
                   * 折成的**只读文本历史**。渲染端必须挂横幅 + 行内标「原始记录已清理」，
                   * 不许把它们当正常明细渲染。缺省 undefined = 正常路径（零成本）。
                   */
                  degraded: z
                    .object({
                      cause: z.enum(["missing", "empty", "schema-break", "truncated"]),
                      /**
                       * 三档事实（##444）：`never-ran` = 还没跑过轮次（不说「不可用」）；
                       * `conclusion-only` = 结论在、明细原文不在；`degraded` = 真降级。
                       * 文案由 `shared/degraded-history::degradedBannerText` 一处拼。
                       */
                      tier: z.enum(["never-ran", "conclusion-only", "degraded"]),
                      note: z.string().describe("人话原因（横幅「历史明细不可用（<note>）」）"),
                      turns: z.number().describe("重建出来的轮数"),
                      dangling: z.number().describe("其中锚点已悬空的轮数（行内「原始记录已清理」）"),
                    })
                    .optional(),
                }),
              }),
              /** 更早的一段（滚动上取）：`cursor` 所在段之前的 `budgetBytes` 字节 */
              historyOlder: RpcSchema.unary({
                desc: `读取本地 agent 会话中**更早的一段** Op 流（向上滚动时补历史）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  cursor: z.string().cliOption({ desc: "上一段的游标（取它之前的窗口）" }),
                  budgetBytes: z
                    .number()
                    .optional()
                    .cliOption({ desc: "窗口字节预算（缺省 0 = 只取前一轮）" }),
                },
                output: z.object({
                  ops: z.array(z.any()),
                  cursor: z.string(),
                  hasMore: z.boolean(),
                  /** 游标失效 ⇒ 本次是退化全量（渲染端必须重置现有段，不能当前缀拼） */
                  stale: z.boolean(),
                }),
              }),
              /**
               * **含指定位置的定长段**（##389 段跳）：命中落在某一轮，就从那一轮取一段读。
               * 与 historyWindow（游标→文件尾）/ historyOlder（游标之前的预算段）区分见 main 侧注释。
               */
              historyAt: RpcSchema.unary({
                desc: `从**指定轮**开始读一段 Op 流（数据层检索命中后的段跳；一次到位，不是"游标→文件尾"）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  at: z
                    .number()
                    .cliArg({ desc: "该轮 start 行的字节偏移（检索命中里带的 at）" }),
                  budgetBytes: z
                    .number()
                    .optional()
                    .cliOption({ desc: "段字节预算（缺省 0 = 取到文件尾；渲染端固定传 4MB）" }),
                },
                output: z.object({
                  ops: z.array(z.any()),
                  cursor: z.string(),
                  hasMore: z.boolean(),
                  /** 后面还有未读内容（段尾 < 文件尾）⇒ 渲染端此刻显示的是**历史** */
                  hasNewer: z.boolean(),
                  /** 位置失效（不是轮首 / 文件被改写）⇒ 本次是退化全量 */
                  stale: z.boolean(),
                }),
              }),
              /**
               * **会话数据层检索**（##389）：在 ops 原文里找字，与 DOM / 虚拟窗口无关
               * ⇒ 未渲染的轮、被压缩掉的历史都能找到。
               */
              find: RpcSchema.unary({
                desc: `在会话 Op 原文里检索（数据层；未渲染的轮与被压缩的历史都可命中）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  query: z.string().cliArg({ desc: "要找的文字（大小写不敏感）" }),
                  text: z
                    .boolean()
                    .optional()
                    .cliOption({ desc: "搜正文（缺省 true）" }),
                  tool: z
                    .boolean()
                    .optional()
                    .cliOption({ desc: "搜工具的输入/输出（缺省 true）" }),
                  think: z
                    .boolean()
                    .optional()
                    .cliOption({ desc: "搜推理（缺省 false）" }),
                  maxTurns: z
                    .number()
                    .optional()
                    .cliOption({ desc: "最多收集多少轮（组数上限，缺省 200）" }),
                },
                output: z.object({
                  hits: z.array(
                    z.object({
                      turnId: z.string(),
                      at: z.number(),
                      blockId: z.string(),
                      kind: z.string(),
                      scope: z.string(),
                      pre: z.string(),
                      hit: z.string(),
                      post: z.string(),
                      label: z.string(),
                      compacted: z.boolean(),
                    }),
                  ),
                  turns: z.number(),
                  more: z.boolean(),
                  scannedTurns: z.number(),
                  scannedBytes: z.number(),
                }),
              }),
              /**
               * 会话 op 流水位（epoch + 行号）。订阅增量前用它校准起点：
               * 先取水位、再拉 history（history 覆盖范围 ≥ 水位），此后从水位起订阅。
               * seq = ops.jsonl 的物理行号（append-only，故行数即水位）；epoch 随 clear 换发。
               */
              opsWatermark: RpcSchema.unary({
                desc: `会话 op 流水位（{epoch, seq}）—— 订阅增量前校准起点（seq=行号，epoch 随清空换发）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.object({ epoch: z.number(), seq: z.number() }),
              }),
              /**
               * 会话 op 增量订阅（写侧即推）：所有来源（本人 / CLI / 另一窗口 / agent 自愈补写）
               * 的 op 落到 main 的同一落盘点后就广播 —— UI 不必轮询、不必在轮结束才重放。
               * 帧形状（OpsFrame 判别联合，见 services/ops-feed.ts）：
               *   {kind:"hello", epoch, seq} 建流首帧水位
               *   {kind:"batch", epoch, fromSeq, ops} 一段连续 op
               *   {kind:"reset", epoch} 会话被清空 → 订阅方重建块树
               */
              opsWatch: RpcSchema.serverStream({
                desc: `订阅会话 op 增量（写侧即推；含 CLI / 他窗口 / 自愈补写）—— 取代 UI 轮询`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  since: z.number().cliArg({ desc: "起始水位（行号）；此后的 op 会被补发" }),
                  epoch: z.number().optional().cliArg({ desc: "订阅方已知的会话代次；不符则首帧后补发 reset" }),
                },
                output: z.any(),
              }),
              clear: RpcSchema.unary({
                desc: `清空本地 agent 会话（中断生成、删除 Op/LLM 日志，并清空待投递的插话队列）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.object({ cleared: z.boolean() }),
              }),
              /**
               * 会话数据落位迁移（##379）：旧平铺 `local/<key>.<kind>.jsonl` → 分层
               * `local/<uri 路径>/<key>/<kind>.jsonl`（工具输出原文一并按会话账本归属搬）。
               * 幂等可中断续跑；目标已存在且不等大时记 conflict 留原地，绝不覆盖。
               * **生产根（DIY_ENV=production）只允许 dry-run**：实迁会直接报错，请用户手动执行。
               */
              migrateLayout: RpcSchema.unary({
                desc: `迁移会话数据落位（旧平铺 → 分层；默认 dry-run 演练）`,
                input: {
                  dryRun: z
                    .boolean()
                    .optional()
                    .cliOption({ desc: "只出「源 → 目标」清单，不动盘（生产根唯一允许的模式；缺省 true）" }),
                  toolout: z
                    .boolean()
                    .optional()
                    .cliOption({ desc: "一并迁移工具输出原文 local/toolout/ → 各会话目录（按会话账本归属；缺省 true）" }),
                },
                output: z.object({
                  dryRun: z.boolean(),
                  moved: z.number(),
                  skipped: z.number(),
                  conflicts: z.number(),
                  unknown: z.number(),
                  total: z.number(),
                  toolOut: z.object({ owned: z.number(), orphan: z.number() }),
                  entries: z.array(
                    z.object({
                      from: z.string(),
                      to: z.string(),
                      action: z.enum(["move", "skip", "conflict", "unknown"]),
                      note: z.string().optional(),
                    }),
                  ),
                  truncated: z.boolean(),
                }),
              }),
              /** 插话队列管理（入队走 `chat --mode`）。step=下一个模型步前；turn=本轮结束后的下一轮。 */
              steer: RpcSchema.group({
                desc: `插话队列：对话中追加的发言（入队走 chat --mode），落任务目录 .diy/drafts.yaml`,
                children: {
                  list: RpcSchema.unary({
                    desc: `列出待投递的插话（FIFO，顺序即投递顺序）`,
                    input: {
                      taskUri: z.string().cliArg({ desc: "任务 URI" }),
                    },
                    output: z.array(SteerItemSchema),
                  }),
                  cancel: RpcSchema.unary({
                    desc: `取消一条待投递插话（幂等：id 不存在返回原队列）`,
                    input: {
                      taskUri: z.string().cliArg({ desc: "任务 URI" }),
                      id: z.string().cliArg({ desc: "插话 id（见 steer list）" }),
                    },
                    output: z.array(SteerItemSchema),
                  }),
                  toggleMode: RpcSchema.unary({
                    desc: `切换一条插话的投递时机（next-step ⇄ next-turn）`,
                    input: {
                      taskUri: z.string().cliArg({ desc: "任务 URI" }),
                      id: z.string().cliArg({ desc: "插话 id（见 steer list）" }),
                    },
                    output: z.array(SteerItemSchema),
                  }),
                  reorder: RpcSchema.unary({
                    desc: `重排待投递插话的顺序（顺序即投递顺序；入参是期望的完整 id 顺序）`,
                    input: {
                      taskUri: z.string().cliArg({ desc: "任务 URI" }),
                      ids: z
                        .array(z.string())
                        .cliArg({ desc: `期望顺序（JSON 数组，如 '["steer/2","steer/1"]'）` }),
                    },
                    output: z.array(SteerItemSchema),
                  }),
                  flush: RpcSchema.serverStream({
                    desc: `
                    立即发送：把队列整批**现在就送出去**，不等下一轮 / 下一步的时机

                    差在"现在"能到达哪里：
                      · 有轮次在跑 → 全部加急为 next-step（下一个模型步之前注入）；
                      · 没有轮次   → 立刻开一轮，队列内容作开场白。
                    只有"开了一轮"时才有 Op 流（JSONL）；加急分支不产 op（队列快照另拉）。
                    `,
                    input: {
                      taskUri: z.string().cliArg({ desc: "任务 URI" }),
                      model: z.string().optional().cliOption({ desc: `临时覆盖模型（缺省 = 任务当前人物的模型）` }),
                      reasoningEffort: z.string().optional().cliOption({ desc: "临时覆盖推理强度（缺省 = 人物配置）" }),
                    },
                    output: z.string(),
                  }),
                },
              }),
              models: RpcSchema.unary({
                desc: `列出本地 agent 可选模型（来自 model.yaml ⊕ snapshot；每项带完全限定名 ref）`,
                input: {},
                output: z.array(
                  z.object({
                    /** 完全限定名 account@provider/model（人物 model 字段就用它） */
                    ref: z.string(),
                    provider: z.string(),
                    account: z.string(),
                    id: z.string(),
                    name: z.string(),
                    api: z.enum(["chat", "responses"]),
                    /** 上下文窗口；spec 未给 → 缺省（UI 显示「—」，运行时按无预算） */
                    contextLimit: z.number().optional(),
                    /** 单次输出上限；spec 未给 → 缺省（运行时回退 DEFAULT_LIMITS.maxOutputTokens） */
                    maxOutputTokens: z.number().optional(),
                    reasoning: z.object({
                      supported: z.array(z.string()),
                      default: z.string(),
                    }),
                    /**
                     * 单价（$/1M tokens；缺失 = 无价目）—— 模型选择表分列展示。
                     * 形状 = `shared/usage.ts` 的 `ModelCostSchema`（含 `baseLabel` 与**分档** `tiers`）。
                     * ⚠️ 这里少写字段**不会**报错（outputSchema 不做运行期校验，见 diy-rpc meta.ts），
                     * 只会让消费端静默拿不到 → 所以形状必须与 schema 同源，别手写第二份。
                     */
                    cost: ModelCostSchema.nullable().optional(),
                  }),
                ),
              }),
              limits: RpcSchema.unary({
                desc: `查询生效运行限制（默认值 < $DIY_HOME/local/limits.json < 环境变量 DIY_LOCAL_*）`,
                input: {},
                output: z.object({
                  maxSteps: z.number(),
                  maxOutputTokens: z.number(),
                  maxOutputTokensSource: z.enum(["env", "file", "default"]),
                  costWarnStepUsd: z.number(),
                  costWarnTurnUsd: z.number(),
                  bashTimeoutMs: z.number(),
                  outputClipChars: z.number(),
                  readMaxBytes: z.number(),
                  maxSteerQueue: z.number(),
                }),
              }),
              /**
               * 会话/轮次注册表（##240）：**本次 main 进程启动后活跃过的会话**（内存态，进程死即消）。
               *
               * 与 `running` 的分工：`running` = 「**此刻**在跑」（轮次结束即摘掉）；
               * 这里是「**本次启动以来活跃过**」—— 轮次结束只清 `turn`、条目保留（R5），
               * 故它同时回答"谁在跑"与"今天动过哪些会话"，且带 steps / tokens / queue / viewers /
               * lastEndReason 深度字段（`running` 只有 taskUri / model / cwd / since）。
               *
               * 订阅语义（R2：状态 ⊥ 内容）：**只推注册表状态、绝不推 op** —— 对话内容归每条会话的
               * `opsWatch`（##307）。这条流**无水位**（快照 + delta 即可，状态可随时整体重放）。
               * `--watch` 的订阅者**不计入 `viewers`**（R3）：注册表是"看状态"，不是"看内容"。
               * CLI 别名：`diy agent local sessions`（不带 `--watch` = 打一份快照就退出）。
               */
              sessions: RpcSchema.serverStream({
                desc: `会话/轮次注册表（本次启动后活跃过的会话）：快照 + 增量；只推状态不推 op（内容见 opsWatch）`,
                input: {
                  watch: z
                    .boolean()
                    .optional()
                    .cliOption({ desc: "持续订阅注册表变更（缺省只打一份快照就退出）" }),
                },
                output: z.any(),
              }),
              /**
               * 写运行限制（##240 第 3 项）：写 `$DIY_HOME/local/limits.json` 并**即时失效缓存**。
               * 语义 = **下一轮生效**（在跑的轮次沿用起跑时的值）；环境变量 `DIY_LOCAL_*` 优先级更高。
               */
              setLimits: RpcSchema.unary({
                desc: `写运行限制（下一轮生效；环境变量 DIY_LOCAL_* 优先级更高，会盖过写入值）`,
                input: {
                  maxSteps: z.number().optional().cliOption({ desc: "单轮最大模型步数（>0）" }),
                  maxOutputTokens: z
                    .number()
                    .optional()
                    .cliOption({ desc: "全局输出软上限（>0；它同时是天花板，任务/人物不得越过它）" }),
                  costWarnStepUsd: z
                    .number()
                    .optional()
                    .cliOption({ desc: "单步成本告警阈值（USD；0 = 关闭该类告警）" }),
                  costWarnTurnUsd: z
                    .number()
                    .optional()
                    .cliOption({ desc: "单轮累计成本告警阈值（USD；0 = 关闭该类告警）" }),
                  bashTimeoutMs: z.number().optional().cliOption({ desc: "单条 bash 命令超时毫秒（>0）" }),
                  outputClipChars: z
                    .number()
                    .optional()
                    .cliOption({ desc: "（已废弃：无消费方。bash 输出截断改由**投递层**按 2000 行 / 50KB 收口，见 services/tool-output.ts）" }),
                  readMaxBytes: z.number().optional().cliOption({ desc: "read 工具单次返回字节上限（>0）" }),
                  maxSteerQueue: z.number().optional().cliOption({ desc: "插话队列条数上限（>0）" }),
                },
                output: z.object({
                  maxSteps: z.number(),
                  maxOutputTokens: z.number(),
                  maxOutputTokensSource: z.enum(["env", "file", "default"]),
                  costWarnStepUsd: z.number(),
                  costWarnTurnUsd: z.number(),
                  bashTimeoutMs: z.number(),
                  outputClipChars: z.number(),
                  readMaxBytes: z.number(),
                  maxSteerQueue: z.number(),
                }),
              }),
              /**
               * 逐步用量账本（`<key>.usage.jsonl`）：结构化返回，UI 的明细/看板与 CLI 走**同一份数据**。
               * 不做服务端预聚合 —— 分组/汇总在 shared/usage.ts 里（纯函数），两端同一套口径。
               */
              usage: RpcSchema.unary({
                desc: `读取本地 agent 的逐步用量账本（每步四桶 + raw + 身份 + 单价快照 + 金额）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.array(z.any()),
              }),
              /**
               * 压缩（compact）命令族。**升为 group 的理由**（##344 M2）：RPC 树的不变量是
               * 「一个节点要么是组、要么是叶子」，命令族要能容下多个动作就得是 group。
               * ##432 起装配计划子命令（`compact plan *`）已整体删除 —— 只留 run / preview /
               * events / summarize。旧平铺名随之归位：`compact` → `compact.run`、
               * `compactPreview` → `compact.preview`、
               * `compactEvents` → `compact.events`、`summarize` → `compact.summarize`。
               */
              compact: RpcSchema.group({
                desc: `压缩会话上下文（按配置的装配管道保留历史 + 裁剪工具输出；历史原地保留可撤销）`,
                children: {
                /**
                 * 压缩会话上下文（**不删任何历史**）：写一条压缩账 `<key>.compact.jsonl`，
                 * 投递时只发管道挑选出的消息 + 按各级 clip 裁工具输出。旧内容原地保留、可查、可撤销。
                 * 与 `clear`（物理删所有日志）语义正交 —— 这里是「少发」，那里是「销毁」。
                 */
                run: RpcSchema.unary({
                desc: `执行压缩（按当前配置的装配管道保留历史 + 裁剪工具输出；历史原地保留可撤销）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  toolResult: z
                    .enum(["asis", "headtail", "callpath"])
                    .optional()
                    .cliOption({ desc: "工具输出处理：asis 原样 / headtail 头尾裁剪 / callpath 只留调用+路径" }),
                  triggerLines: z.number().optional().cliOption({ desc: "头尾裁剪：超过多少行才裁（缺省 6）" }),
                  headLines: z.number().optional().cliOption({ desc: "头尾裁剪：保留头部行数（缺省 3）" }),
                  tailLines: z.number().optional().cliOption({ desc: "头尾裁剪：保留尾部行数（缺省 3）" }),
                  maxLineChars: z.number().optional().cliOption({ desc: "单行超长截断阈值（字符，缺省 300）" }),
                  maxKeepBytes: z.number().optional().cliOption({ desc: "保留总量字节兜底（缺省 8192）" }),
                  summary: z.boolean().optional().cliOption({ desc: "是否计算历史摘要带进新会话（缺省否）" }),
                  summaryText: z.string().optional().cliOption({ desc: "已生成的摘要文本（先跑 summarize；缺省则不投摘要）" }),
                  summaryData: z.any().optional(),
                  summaryCost: z.number().optional(),
                },
                output: z.any(),
              }),
                /** 压缩预览：只算不写（panel 的「事实」行与预览页都用它；与真发同一份纯函数） */
                preview: RpcSchema.unary({
                  desc: `预览压缩效果（只算不写；返回 base/mod 请求 / 前后规模 / 丢弃轮明细 / 裁剪明细 / 分层费用 facts）`,
                  input: {
                    taskUri: z.string().cliArg({ desc: "任务 URI" }),
                    toolResult: z.enum(["asis", "headtail", "callpath"]).optional().cliOption({ desc: "工具结果的处理方式（asis/headtail/callpath）" }),
                    triggerLines: z.number().optional().cliOption({ desc: "头尾裁剪阈值行数" }),
                    headLines: z.number().optional().cliOption({ desc: "头尾裁剪保留头行数" }),
                    tailLines: z.number().optional().cliOption({ desc: "头尾裁剪保留尾行数" }),
                    maxLineChars: z.number().optional().cliOption({ desc: "单行超长截断阈值" }),
                    maxKeepBytes: z.number().optional().cliOption({ desc: "保留总量字节兜底" }),
                    summary: z.boolean().optional().cliOption({ desc: "是否算摘要" }),
                    summaryText: z.string().optional().cliOption({ desc: "已生成的摘要文本（缺省用占位骨架）" }),
                  },
                  output: z.any(),
                }),
                // 装配管道（plan）的 get/set/check/reset/versions/version/restore 已于 ##432 整体删除：
                // 用户 2026-10-25 拍板「该清理的清理掉」—— 不让人/agent 去编排装配计划，
                // 配置面只剩 `history.limit.limitTokens`（+ `summary.enabled`）。

                /**
                 * 压缩事件账（历史页数据源）：**不可变快照列表**。
                 * 每条自带**算法**（`policy.mode`）与**当时整条 plan**（v3 起：`plan` 快照 ⇒ 可回放
                 * 「那一刻用的是哪套 plan」）。【用户 2026-10-07】取代 generations（连续分代不适合预算的分散保留）。
                 */
                events: RpcSchema.unary({
                  desc: `读取压缩事件账（历史页快照列表：时间/算法/过滤器/前后规模/方式·理由）。
**限读尾部**（最近 200 条 / 256 KB，##431）：回包 = { events, truncated, size, from }，
truncated=true 表示更早的记录未加载（界面必须显式标出来，不许静默截断）`,
                  input: {
                    taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  },
                  output: z.object({
                    /** 账本事件（按文件顺序；截断时只含尾部窗口内那些） */
                    events: z.array(z.any()),
                    /** 更早的记录未加载（界面必须显式标出，不许静默截断） */
                    truncated: z.boolean(),
                    /** 账本总字节数（限读不改变「它有多大」这个事实） */
                    size: z.number(),
                    /** 本次返回的窗口起点（字节偏移；truncated=true 时 >0） */
                    from: z.number(),
                  }),
                }),
                /**
                 * 生成历史摘要（压缩承接）：对**将被丢弃的轮**做一次结构化抽取（一次模型调用，花钱）。
                 * 与 run 分开：摘要是可选增强、且要用户显式掏钱；压缩本身不调模型。
                 */
                summarize: RpcSchema.unary({
                  desc: `生成历史摘要（对将被丢弃的轮做结构化抽取；一次模型调用）`,
                  input: {
                    taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  },
                  output: z.any(),
                }),
                },
              }),
              /**
               * 自动压缩检测（只读）：三个**确定事实**（系统上下文变 / 缓存过期 / 窗口超限）
               * 是否成立 + 当前配置 + 生效 TTL。UI 据此提示「此刻压缩无重建代价」。
               */
              autoCompactStatus: RpcSchema.unary({
                desc: `检测自动压缩触发（只读；返回事实/触发理由/生效 TTL/当前配置）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.any(),
              }),
              /**
               * 写自动压缩配置（真源 = `$DIY_HOME/auto-compact.yaml`，手改或经此写回都行）。
               */
              autoCompactSetConfig: RpcSchema.unary({
                desc: `写自动压缩配置（真源 $DIY_HOME/auto-compact.yaml；patch = 部分字段，浅合并后归一）`,
                input: {
                  patch: z
                    .unknown()
                    .optional()
                    .cliOption({ desc: "部分配置（mode / triggers / policy），浅合并后写回" }),
                  taskUri: z
                    .string()
                    .optional()
                    .cliOption({ desc: "任务 URI（只用于版本链记账：写 history.keep[] 时记下是谁改的）" }),
                },
                output: z.any(),
              }),
              /** 当前生效请求的展示模型（系统/工具/消息的实际投递内容）；CLI/调试用 */
              requestView: RpcSchema.unary({
                desc: `读取当前生效请求的实际投递内容（system / tools / messages；压缩预览的 base 侧）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.any(),
              }),
            },
          }),

          /**
           * 会话用量报表（人看的口径）：CLI 直出的等宽表格。
           *
           * 为什么不复用 agent.local.usage：那条给 UI 结构化数据；这条是**人读**的渲染
           * （对齐、单位、n/a 表达都在 main 里做一次）。两者共用同一份账（usage.jsonl）
           * 与同一套聚合（shared/usage），不是两套统计。
           */
          usage: RpcSchema.unary({
            desc: `查看任务会话的 token 用量与金额（逐步明细 / --by-agent 按人物+模型+面+档位汇总）`,
            input: {
              task: z.string().cliArg({ desc: "任务 URI" }),
              last: z.number().optional().cliOption({ desc: "只看最近 N 步" }),
              cost: z.boolean().optional().cliOption({ desc: "展开金额细分列（非缓存/缓存读/缓存写/文本/思考）" }),
              byAgent: z.boolean().optional().cliOption({ desc: "按人物+模型+面+档位汇总（多 agent 多行）" }),
            },
            output: z.string(),
          }),
        },
      }),

      /**
       * 多人房间（room）—— 人 + 多 agent 同室对话的**投递 + 汇总层**。
       *
       * 设计真源 ##166 §28：room ≠ session（不承载成员上下文）；成员各自独立会话
       * （本切片按待决 72 的 (a)：agent 成员绑一个 task 的本地会话）；投递由 `@X` / `focus`
       * 决定、**协议里没有广播**。开发日志 ##377。
       */
      room: RpcSchema.group({
        desc: `多人房间（人 + 多 agent 同室；room 只做投递 + 汇总，各成员有自己的会话）。**宿主定案（##166 §28.7 G）：room = 任务对话页的状态，id 就是 taskUri** —— 每个任务恒是一个 room（不加人 = 成员表只有主人格）`,
        children: {
          list: RpcSchema.unary({
            desc: `列出全部房间（成员数 / 当前接受者 / 最后一条发言）`,
            input: {},
            output: z.object({
              rooms: z.array(
                z.object({
                  id: z.string(),
                  title: z.string().optional(),
                  focus: z.string().nullable(),
                  members: z.number(),
                  last: z.string().optional().describe("最后一条发言摘要（无发言则缺省）"),
                }),
              ),
            }),
          }),
          get: RpcSchema.unary({
            desc: `读一个房间（成员表 + 最近事件流）`,
            input: {
              id: z.string().cliArg({ desc: "任务 URI（= room id；宿主定案后就是任务对话页的那个任务）" }),
              limit: z.number().optional().cliOption({ desc: "事件条数上限（缺省 200）" }),
            },
            output: z.object({
              room: RoomSchema.nullable(),
              events: z.array(RoomEventSchema),
              /** 事件流里的坏行数（>0 = 有半截写入；不隐藏） */
              badLines: z.number(),
            }),
          }),
          create: RpcSchema.unary({
            desc: `确保一个任务的 room 存在（幂等；成员表恒含「我」+ 主人格，focus 缺省 = 主人格）`,
            input: {
              id: z.string().cliArg({ desc: "任务 URI（= room id）" }),
              title: z.string().optional().cliOption({ desc: "标题（给人看；缺省取任务标题）" }),
              human: z.string().optional().cliOption({ desc: "人的显示名（缺省 chen56）" }),
            },
            output: RoomSchema,
          }),
          addMember: RpcSchema.unary({
            desc: `加 agent 成员（**高级入口**：手填名字 + 绑一个已有 task；给人物请用 room invite）`,
            input: {
              id: z.string().cliArg({ desc: "任务 URI（= room id）" }),
              name: z.string().cliArg({ desc: "成员名（@ 寻址用）" }),
              task: z.string().cliOption({ desc: "该成员绑的任务 URI（其会话即它的 backend）" }),
              persona: z.string().optional().cliOption({ desc: "人物 id（决定它以什么身份/行为说话）" }),
              role: z.string().optional().cliOption({ desc: "它是干什么的（喂 UI / 将来喂模型）" }),
            },
            output: RoomSchema,
          }),
          /**
           * **邀请 = 选人物**（##166 §28.7 F ② / D 的 B 方案）。
           *
           * 面板列**人物**（不列 task）：选中人物 ⇒ 为它分配 backend —— 缺省**自动建一个专属
           * 「影子 task」**（复用现有一切：CLI/RPC/装配/UI，**零内核改动**）；`--task` 是**高级入口**
           * （指定绑一个已有 task，即原来手填 taskUri 的做法）。
           *
           * 护栏：**同一 backend 不得挂两个人物**（= A 帽子，##166 §27 已否）；同一人物可进多个 room。
           */
          invite: RpcSchema.unary({
            desc: `邀请一个**人物**进房间（缺省为它建影子 task 作 backend；--task = 高级入口，绑已有任务）`,
            input: {
              id: z.string().cliArg({ desc: "任务 URI（= room id）" }),
              persona: z.string().cliArg({ desc: "人物 id 或名字（见 agent persona list）" }),
              task: z.string().optional().cliOption({ desc: "高级：绑这个已有任务（不给则自动建影子 task）" }),
              role: z.string().optional().cliOption({ desc: "它是干什么的（喂 UI / 将来喂模型）" }),
            },
            output: z.object({
              room: RoomSchema,
              member: RoomMemberSchema,
              /** 影子 task（新建时回带 URI —— 成员会话的底座就是它） */
              taskUri: z.string(),
              createdTask: z.boolean().describe("backend 是新建的影子 task（false = 复用了已有任务）"),
            }),
          }),
          removeMember: RpcSchema.unary({
            desc: `移出成员（主人格不可移出 —— 它就是宿主任务本身）`,
            input: {
              id: z.string().cliArg({ desc: "任务 URI（= room id）" }),
              member: z.string().cliArg({ desc: "成员名或 id" }),
            },
            output: RoomSchema,
          }),
          focus: RpcSchema.unary({
            desc: `设置当前接受者（不给成员 = 清空；投递只由 @X / focus 决定，无第三方调度器）`,
            input: {
              id: z.string().cliArg({ desc: "任务 URI（= room id）" }),
              member: z.string().optional().cliArg({ desc: "成员名或 id（省略 = 清空 focus）" }),
            },
            output: RoomSchema,
          }),
          /**
           * **人成员的未读 / 已读**（##377 第 28 刀）。
           *
           * 游标本身住在 `room.yaml` 的 `lastSeen[<人成员 id>]`（与 agent 的投递水位同一个字段，
           * 见 `RoomSchema.lastSeen` 的注释）—— 所以**读**不需要新口子，`room get` 已经把
           * `lastSeen` 带回来了；这里只补**写**（前移）。
           *
           * 判据（未读条数 / 第一条未读 / 流尾落点）唯一真源 = `shared/room::unreadSince`。
           */
          read: RpcSchema.unary({
            desc: `标记房间已读（把**人成员**的阅读游标前移到最后一条事件，或指定 --event）`,
            input: {
              id: z.string().cliArg({ desc: "房间 id（= 任务 URI；侧边栏 room 用它的 id）" }),
              event: z
                .string()
                .optional()
                .cliOption({ desc: "前移到这条事件 id（缺省 = 事件流最后一条）" }),
            },
            output: z.object({
              room: RoomSchema.nullable(),
              /** 真的前移了（false = 已经是这一条 / 没有房间 / 没有人成员 —— 都不算失败） */
              advanced: z.boolean(),
              /** 前移后的游标（人成员是谁、前移到哪条） */
              read: z.object({ member: z.string(), event: z.string() }).nullable(),
            }),
          }),
          post: RpcSchema.serverStream({
            desc: `在房间里说一句 —— 解析收件人 → 投递给各 agent（在它自己的会话里真起一轮）→ 回复带署名回写；逐行输出事件（JSONL）`,
            input: {
              id: z.string().cliArg({ desc: "任务 URI（= room id）" }),
              text: z.string().cliArg({ desc: "发言正文（开头 @名字 覆盖当前接受者）" }),
            },
            output: z.string(),
          }),
          /**
           * 一条 `reply` 的**进度**（##166 §28.7 A）—— room 不新造进度数据源：
           * 它只是把「成员会话里的那一轮」取回来（`ref = { memberUri, turnId }`）。
           * 渲染端拿到的是**块树**，与任务对话走同一个渲染器（`LocalChatPage` 的 `TurnView`）。
           */
          /**
           * 取某一轮的进度块树（**两种寻址**：按 reply 事件 id，或按 `(成员, 轮次)`）。
           *
           * 口径（##166 第三轮第 2 条）：给 `(memberUri, turnId)` 返回该轮的进度块流。
           * 事件寻址是 room 侧的便利形态（reply 事件自带 `ref`），`--member/--turn` 是口径的**字面形态**
           * （调用方手上只有成员 + 轮次时不必先捞事件）。两者共用同一条底座（`agent.local.turn`）。
           */
          turn: RpcSchema.unary({
            desc: `取某一轮的进度块树（成员会话的引用；room 自己不留进度数据）`,
            input: {
              id: z.string().cliArg({ desc: "房间 id" }),
              event: z
                .string()
                .optional()
                .cliArg({ desc: "reply 事件 id（room get 里给）；与 --member/--turn 二选一" }),
              member: z.string().optional().cliOption({ desc: "成员 id / 名字（与 --turn 配对）" }),
              turn: z.string().optional().cliOption({ desc: "轮次 id（与 --member 配对）" }),
            },
            output: z.object({
              /** 那一轮的块树（找不到 = null，UI 如实显示"这一轮已不在会话里"） */
              turn: z.any().nullable(),
              /** 成员会话（task uri），供 UI 显示/跳转 */
              taskUri: z.string(),
              turnId: z.string(),
              /** 命中的成员 id（按事件寻址时 = ref.memberUri；按成员寻址时 = 解析出的成员 id） */
              memberUri: z.string().nullable(),
              /** 该成员此刻是否正有轮次在跑（决定 UI 是"直播中"还是"已完成"） */
              live: z.boolean(),
              /** 会话注册表条目（L1；与 `agent.local.turn` 同一份真源） */
              entry: z.any().nullable(),
              /** 此刻在干什么（未闭合块；空闲 = null） */
              action: z.object({ kind: z.string(), label: z.string() }).nullable(),
            }),
          }),
          /**
           * 成员**此刻**状态（**L1 状态数据**；owner ##166 第三轮口径第 3 条）。
           *
           * 口径原话：「成员此刻在干什么（正在跑哪一步 / 已用时长 / 状态）—— 服务端能给出，不靠 UI 猜」。
           * 这里把**三份既有真源**合成一份视图，不新造状态：
           *   · 会话侧 —— 会话注册表条目（`turn.steps` / `startedAt` / `state` / `viewers` …）
           *   · 进度侧 —— 未闭合块 ⇒「正在 bash · rg -n …」（`local-agent.currentAction`）
           *   · room 侧 —— 该成员的投递链（`queued` / `running` 条数）
           *
           * 纯读、无副作用；任何布局的「头像行状态」都吃这一份（L2 详情另走 `turn`）。
           */
          roster: RpcSchema.unary({
            desc: `房间成员的此刻状态（L1：在跑吗 / 第几步 / 在做什么 / 已用时长 / 排队数）`,
            input: { id: z.string().cliArg({ desc: "房间 id" }) },
            output: z.object({
              room: z.string(),
              now: z.number().describe("服务端时刻（epoch ms）"),
              members: z.array(
                z.object({
                  memberId: z.string(),
                  name: z.string(),
                  avatar: z.string(),
                  color: z.string(),
                  role: z.string(),
                  isHuman: z.boolean(),
                  focus: z.boolean(),
                  taskUri: z.string().nullable(),
                  entry: z.any().nullable().describe("会话注册表条目（人的 / 未绑任务的成员为 null）"),
                  action: z.object({ kind: z.string(), label: z.string() }).nullable(),
                  queued: z.number().describe("该成员在投递链上排队的条数（此刻）"),
                  running: z.number().describe("该成员正在跑的投递条数（单成员串行 ⇒ 0 或 1）"),
                }),
              ),
            }),
          }),
        },
      }),

      /**
       * 文件读取工具（行窗口 + 续读）。
       *
       * 为什么不复用内置 read 工具：内置 read 是**模型工具调用**，只在 agent 会话里可达；
       * CLI 侧需要一份等价能力 —— agent 可经 bash 调它（绕开工具输出的截断），人也能直接看。
       * 两侧共用 core/file-read.ts 的同一实现（窗口语义只有一份，见该文件头注释）。
       */
      tool: RpcSchema.group({
        desc: `工具（文件读取：行窗口 + 续读）`,
        children: {
          read: RpcSchema.unary({
            desc: `
            读取文本文件（行窗口，可续读）

            与整文件截断的关键差别：超出上限时尾部给出 --offset 续读入口，
            可精确跳到没读过的部分，不会像「取头尾、丢中间」那样永久丢失中段。
            行/字节双限（缺省 2000 行 / 50KB，谁先到算谁）。
            不设单行字符数上限 —— 单行只受同一份字节预算约束（jsonl 这类「一行一条记录」
            的文件不会被砍半行）。
            `,
            input: {
              // resolvePath：相对路径按**敲命令的 shell 的 cwd** 解析成绝对路径（见 rpc cli/_parser.ts）。
              // 不能靠 handler 侧的 process.cwd() —— 那是 app 进程的应用目录，不是用户的目录。
              path: z.string().cliArg({ desc: "文件路径（相对路径按当前目录解析）", resolvePath: true }),
              offset: z.number().optional().cliOption({ desc: "起始行，1-based（缺省 1）" }),
              limit: z.number().optional().cliOption({ desc: "最大行数（缺省 2000）" }),
            },
            output: z.string(),
          }),
        },
      }),

      // —— 提示词模版试验场（spike）：内置只读 + 项目级同路径覆盖 + dry-run 预览 ——
      template: RpcSchema.group({
        desc: `提示词模版（内置只读，项目级覆盖；仅构造请求，不发 LLM）`,
        children: {
          list: RpcSchema.unary({
            desc: `列出全部模版（含状态/元数据，供树展示）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
            },
            output: z.array(PromptEntrySchema),
          }),
          get: RpcSchema.unary({
            desc: `取单份模版（含内置/当前/stale）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              relpath: z.string().cliArg({ desc: "模版相对路径" }),
            },
            output: PromptEntrySchema,
          }),
          save: RpcSchema.unary({
            desc: `保存项目级覆盖（不可覆盖项拒绝）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              relpath: z.string().cliArg({ desc: "模版相对路径" }),
              content: z.string().cliArg({ desc: "覆盖正文" }),
            },
            output: PromptEntrySchema,
          }),
          restore: RpcSchema.unary({
            desc: `一键恢复（删覆盖，回退内置）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              relpath: z.string().cliArg({ desc: "模版相对路径" }),
            },
            output: PromptEntrySchema,
          }),
          preview: RpcSchema.unary({
            desc: `dry-run 预览：装配系统上下文 + 仿真请求体（只组装不发送）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().optional().cliOption({ desc: "任务 URI（任务场景与工作目录从它推，并以其 project 为准）" }),
              model: z.string().optional().cliOption({ desc: `模型 id（缺省 gpt-5.6-luna；应传会话实际选中的模型才算保真）` }),
              // 无 CLI 注解：CLI 解析器忽略，RPC 照传（未存盘草稿渲染用）
              drafts: z.record(z.string(), z.string()).optional().describe("未存盘草稿 relpath→正文"),
            },
            output: RequestPreviewSchema,
          }),
        },
      }),

      context: RpcSchema.group({
        desc: `上下文树（当前任务的真实系统上下文；只组装不发送）`,
        children: {
          config: RpcSchema.unary({
            desc: `读划分规则（$DIY_HOME/context.yaml；真发与页面共用这一份）`,
            input: {},
            output: z.object({
              systemPlaces: z.array(z.string()).describe("当前生效的 system 单元（其余自动 runtime）"),
              defaults: z.array(z.string()).describe("推荐名单（文件缺失/清空时用它）"),
              fromFile: z.boolean().describe("是否来自 context.yaml（false = 用推荐名单）"),
              inputLimitChars: z.number().describe("用户单条消息的字符上限（##426 B）"),
            }),
          }),
          setConfig: RpcSchema.unary({
            desc: `写划分规则（非法路径或互为祖先/后代一律拒绝；下一轮真发生效）`,
            input: {
              systemPlaces: z.array(z.string()).cliOption({ desc: "进 system 的单元（JSON 数组）" }),
              inputLimitChars: z.number().optional().cliOption({ desc: "用户单条消息的字符上限（##426 B）" }),
            },
            output: z.object({
              systemPlaces: z.array(z.string()),
              inputLimitChars: z.number().nullable().describe("当前输入上限（本次没改 = 原值）"),
            }),
          }),
          candidates: RpcSchema.unary({
            desc: `列出候选投递单元与默认 system 名单`,
            input: {},
            output: z.object({
              candidates: ContextPlaceCandidateSchema,
              defaultSystem: z.array(z.string()),
            }),
          }),
          lab: RpcSchema.unary({
            desc: `上下文树数据：变量树 + 划分规则 + system/runtime 两份 + 合成消息`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().optional().cliOption({ desc: "任务 URI（缺省则只有项目级上下文）" }),
              systemPlaces: z
                .array(z.string())
                .optional()
                .cliOption({ desc: "划入 system 的投递单元（JSON 数组；缺省用推荐名单，其余自动 runtime）" }),
              model: z.string().optional().cliOption({ desc: "模型 id（请求体预览用；缺省取默认模型）" }),
            },
            output: ContextLabSchema,
          }),
          steps: RpcSchema.unary({
            desc: `每轮真发的投递快照（step）：值变化 + 两份容器的 diff（默认只给统计，--diff 给行内容）`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
              limit: z.number().optional().cliOption({ desc: "只看最近 N 步（缺省全部）" }),
              diff: z
                .boolean()
                .optional()
                .cliOption({ desc: "带上行级 diff 内容（默认只有增删统计，避免下发整份文本）" }),
            },
            output: StepsSchema,
          }),
          stats: RpcSchema.unary({
            desc: `节点变更统计（按项目累计；回答"用了几天，某节点变了几次"）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().optional().cliOption({ desc: "只算某个任务（缺省：整个项目累计）" }),
              limit: z.number().optional().cliOption({ desc: "只看最近 N 轮（缺省全部）" }),
            },
            output: StatsSchema,
          }),
          changelog: RpcSchema.unary({
            desc: `变更历史：每步**有变才写**（每段会话起点给一条 baseline 整棵树）；变更单位 = 原子单元，before/after 自带；附 ref（当轮划分 / 缓存率 / 金额）`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
              limit: z.number().optional().cliOption({ desc: "只看最近 N 轮（缺省全部）" }),
            },
            output: CtxLogSchema,
          }),
          rebaseline: RpcSchema.unary({
            desc: `重置变更历史的起点：该任务**下一步真发**时写一条新 baseline（整棵树）。临时手工入口 —— 会话注册表/关停启动机制落地后改由「会话启动」自动触发，本命令留作调试`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: z.object({
              ok: z.boolean().describe("是否已置位（true = 下一步真发落新起点）"),
              message: z.string().describe("给用户看的一句话（本轮下次真发生效；当轮已开跑则下一轮）"),
            }),
          }),
          diff: RpcSchema.unary({
            desc: `某步 vs 上一步的 diff；不给 --step 则是「当前变量树 vs 最后一步」（main 侧算完）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
              step: z.number().optional().cliOption({ desc: "第几步（1 基）；缺省 = 当前 vs 最后一步" }),
              systemPlaces: z
                .array(z.string())
                .optional()
                .cliOption({ desc: "当前投递的 system 名单（缺省用推荐名单）" }),
            },
            output: ContextDiffSchema.nullable(),
          }),
        },
      }),

      llmProxy: RpcSchema.group({
        desc: `LLM 代理`,
        children: {
          status: RpcSchema.unary({
            desc: `查询 LLM 代理状态`,
            input: {},
            output: z.object({ running: z.boolean(), port: z.number() }),
          }),
          start: RpcSchema.unary({
            desc: `启动 LLM 代理`,
            input: {},
            output: StatusOk,
          }),
          stop: RpcSchema.unary({
            desc: `停止 LLM 代理`,
            input: {},
            output: StatusOk,
          }),
        },
      }),

      traffic: RpcSchema.group({
        desc: `流量（应用发出去的 HTTP 请求 / 收到的响应；内存留最近若干条 + 逐条追加到 log/network/ 磁盘日志）`,
        children: {
          snapshot: RpcSchema.unary({
            desc: `取当前流量快照（开关状态 + 内存里的记录）。withRecords=false 时只回状态、不带记录数组`,
            input: {
              withRecords: z
                .boolean()
                .optional()
                .cliOption({ desc: "是否带上记录数组（默认 true；界面只关心开关状态时可省）" }),
            },
            output: TrafficSnapshotSchema,
          }),
          clear: RpcSchema.unary({
            desc: `清空流量记录（仅内存里的即时列表；磁盘日志不动）`,
            input: {},
            output: StatusOk,
          }),
          readLog: RpcSchema.unary({
            desc: `按位置读取磁盘日志里的一条记录（文件失效 / 版本不符时 ok=false 并给原因）`,
            input: {
              file: z.string().cliArg({ desc: "日志文件（相对 DIY_HOME）" }),
              offset: z.number().cliArg({ desc: "起始字节" }),
              len: z.number().cliArg({ desc: "字节长度" }),
            },
            output: z.object({
              ok: z.boolean(),
              message: z.string().nullable().describe("失败原因（人话）"),
              record: z.any().nullable().describe("读到的原始记录"),
            }),
          }),
          query: RpcSchema.unary({
            desc: `按条件查磁盘日志（流量页数据源）：全文关键词 / 状态 / 方法 / 日期（不传或 all = 全部日期）`,
            input: {
              text: z.string().optional().cliArg({ desc: "全文关键词（匹配地址、方法、状态、模型、正文等）" }),
              status: z.enum(["all", "ok", "4xx", "5xx", "err"]).optional().cliArg({ desc: "状态过滤" }),
              method: z.string().optional().cliArg({ desc: "HTTP 方法（all = 不限）" }),
              date: z.string().optional().cliArg({ desc: "日期 YYYY-MM-DD / all" }),
              limit: z.number().optional().cliArg({ desc: "最多返回条数（默认 1000）" }),
            },
            output: z.object({
              records: z.array(z.any()).describe("命中的记录（含 log 位置），按时间倒序"),
              scanned: z.number().describe("扫过的行数"),
              files: z.array(z.string()).describe("扫过的文件"),
              hits: z.number().describe("命中数"),
              truncated: z.boolean().describe("是否因超过 limit 被截断"),
              ms: z.number().describe("耗时 ms"),
            }),
          }),
          logFiles: RpcSchema.unary({
            desc: `列出磁盘上的流量日志文件、日期与总体积（头部「日志大小」/ 日期过滤 / 清理面板用）`,
            input: {},
            output: z.object({
              dir: z.string(),
              files: z.array(z.string()),
              dates: z.array(z.string()).describe("出现过的日期（新的在前）"),
              bytes: z.number().describe("日志目录总字节数"),
              detail: z
                .array(
                  z.object({
                    file: z.string(),
                    date: z.string(),
                    bytes: z.number(),
                    mtimeMs: z.number(),
                    today: z.boolean().describe("当天文件（正在写入 → 不可清理）"),
                  }),
                )
                .describe("逐文件详情（清理面板：列文件 + 显示占用）"),
            }),
          }),
          cleanLogs: RpcSchema.unary({
            desc: `清理磁盘流量日志（删整个按天文件）。files 或 keepDays 二选一；今天正在写入的文件一律不删；dryRun 只算不删`,
            input: {
              files: z
                .array(z.string())
                .optional()
                .cliOption({ desc: `要删的文件（相对 DIY_HOME），JSON 数组如 '[\"log/network/2026-10-01.jsonl\"]'` }),
              keepDays: z
                .number()
                .int()
                .min(1)
                .optional()
                .cliOption({ desc: "只留最近 N 天（含今天），删更早的日期文件" }),
              dryRun: z.boolean().optional().cliOption({ desc: "试运行：只统计将删什么 / 释放多少，不动磁盘" }),
            },
            output: z.object({
              deleted: z.array(z.string()).describe("真删掉的文件"),
              freedBytes: z.number().describe("释放的字节数"),
              skipped: z.array(z.object({ file: z.string(), reason: z.string() })).describe("被跳过的（附原因）"),
              remaining: z.object({ files: z.number(), bytes: z.number() }).describe("清理后剩余（文件数 / 字节）"),
            }),
          }),
          revealLog: RpcSchema.unary({
            desc: `在系统文件管理器里定位到某个日志文件（打开所在目录并选中该文件）`,
            input: { file: z.string().cliArg({ desc: "日志文件（相对 DIY_HOME）" }) },
            output: z.object({
              ok: z.boolean(),
              message: z.string().nullable().describe("失败原因（人话）"),
            }),
          }),
          setFullCapture: RpcSchema.unary({
            desc: `开关「记录完整请求内容」（开 = 正文不再截断，全留；默认关 = 超长正文只留首尾一段）`,
            input: { on: z.boolean().cliArg({ desc: "true 开 / false 关" }) },
            output: TrafficSnapshotSchema,
          }),
          setCap: RpcSchema.unary({
            desc: `设置内存保留条数上限`,
            input: {
              n: z.number().cliArg({ desc: "条数上限（1..5000）" }),
            },
            output: TrafficSnapshotSchema,
          }),
          events: RpcSchema.serverStream({
            desc: `流量变更事件流（记录 / 清空 / 开关变更时推版本号；UI 收到后拉 snapshot）`,
            input: {},
            output: z.object({ version: z.number() }),
          }),
        },
      }),

      llmConfig: RpcSchema.group({
        desc: `模型 provider 配置（$DIY_HOME/model.yaml + providers.custom.yaml）`,
        children: {
          read: RpcSchema.unary({
            desc: `读全量视图（spec + 配置 + 可见模型）`,
            input: {},
            output: LlmConfigViewSchema,
          }),
          write: RpcSchema.unary({
            desc: `整份回写 model.yaml（原子写；结构非法抛错）`,
            input: { modelFile: ModelConfigFileSchema },
            output: StatusOk,
          }),
          writeSpec: RpcSchema.unary({
            desc: `写/删 providers.custom.yaml 单条（spec=null 删除）`,
            input: { id: z.string().cliArg({ desc: "custom provider 裸 id" }), spec: SpecProviderSchema.nullable() },
            output: StatusOk,
          }),
          costs: RpcSchema.unary({
            desc: `列出 provider 的模型与生效价目（登记前先跑：拿 model id / 现价 / 可写落点）`,
            input: {
              provider: z.string().cliArg({ desc: "provider（裸 id 或 custom:<id>，如 custom:goat）" }),
            },
            output: ProviderCostsViewSchema,
          }),
          setCost: RpcSchema.unary({
            desc: `登记/更新模型单价（$ / 1M tokens；合并语义，只改给出的字段）`,
            input: {
              provider: z.string().cliArg({ desc: "provider（裸 id 或 custom:<id>）" }),
              model: z.string().cliArg({ desc: "模型 id（见 llmConfig costs）" }),
              target: z.enum(["auto", "spec", "override"]).default("auto").cliOption({ desc: "落点：spec=providers.custom.yaml · override=model.yaml" }),
              input: z.number().nonnegative().optional().cliOption({ desc: "非缓存 $/1M" }),
              output: z.number().nonnegative().optional().cliOption({ desc: "输出 $/1M" }),
              cacheRead: z.number().nonnegative().optional().cliOption({ desc: "缓存读 $/1M" }),
              cacheWrite: z.number().nonnegative().optional().cliOption({ desc: "缓存写 $/1M" }),
              baseLabel: z.string().optional().cliOption({ desc: "未命中时段档时的档名（如 off-peak）" }),
              clear: z.boolean().optional().cliOption({ desc: "删除整个 cost 块（含时段档）" }),
              clearFields: z.array(z.enum(["input", "output", "cache_read", "cache_write", "baseLabel"])).optional().cliOption({ desc: `清指定字段（JSON 数组，如 '["cache_write"]'）` }),
            },
            output: CostUpdateResultSchema,
          }),
          setTiers: RpcSchema.unary({
            desc: `登记/更新时段档（utc-range 峰谷价；--tiers / --drop / --clear 三选一）`,
            input: {
              provider: z.string().cliArg({ desc: "provider（裸 id 或 custom:<id>）" }),
              model: z.string().cliArg({ desc: "模型 id（见 llmConfig costs）" }),
              target: z.enum(["auto", "spec", "override"]).default("auto").cliOption({ desc: "落点：auto=custom→spec、std→override" }),
              tiers: z.array(TierWriteSchema).optional().cliOption({ desc: `时段档 JSON 数组，如 '[{"input":0.5,"output":3,"tier":{"type":"utc-range","data":{"start":"01:00:00+08:00","end":"04:00:00+08:00","calendar":"CN-business-day","label":"peak"}}}]'` }),
              append: z.boolean().optional().cliOption({ desc: "与 --tiers 合用：追加，不改既有档" }),
              drop: z.number().int().nonnegative().optional().cliOption({ desc: "删第 n 条时段档（0-based，只数 utc-range）" }),
              clear: z.boolean().optional().cliOption({ desc: "删光全部时段档（context 上下文档不动）" }),
            },
            output: CostUpdateResultSchema,
          }),
          scanEnv: RpcSchema.unary({
            desc: `扫环境变量得到可导入的 provider 候选（models.dev 声明的 env ∩ process.env，再与现有配置比对）`,
            input: {},
            output: ScanEnvResultSchema,
          }),
          importEnv: RpcSchema.unary({
            desc: `导入环境变量命中的 provider（写 $VAR 引用；已配置/密钥重复的跳过）`,
            input: {
              providers: z
                .array(z.string())
                .optional()
                .cliOption({ desc: "只导入这些 provider id（缺省 = 全部可导入项）" }),
            },
            output: ImportEnvResultSchema,
          }),
          /**
           * 模型目录刷新（##385）：抓 models.dev 上游 → 校验 → 有 diff 才写 `$DIY_HOME/data/models.dev.json`。
           * 手工按钮（模型页 / 模型不可用 bar）与定时任务共用同一实现（core/models-sync.ts）。
           * **失败不抛**：`ok=false` + `error`，本地快照逐字不变（fail-soft，§3.4）。
           */
          syncModels: RpcSchema.unary({
            desc: `刷新模型目录（抓 models.dev → 结构校验 → 有 diff 才写 $DIY_HOME；失败保留旧文件）`,
            input: {},
            output: ModelsRefreshResultSchema,
          }),
          probe: RpcSchema.unary({
            desc: `探测 provider 连通性并拉 ${"${baseUrl}"}/models（UI「测试/获取模型」共用）`,
            input: {
              baseUrl: z.string().cliArg({ desc: "provider baseUrl" }),
              apiKey: z.string().cliArg({ desc: "密钥原始值（明文或 $VAR，服务端展开）" }),
            },
            output: ProbeResultSchema,
          }),
        },
      }),

      seed: RpcSchema.group({
        desc: `初始数据种入（lab 空数据根；幂等，已存在不动）—— 只种**示例/测试数据**，真配置由 ./sha.sh sync 同步`,
        children: {
          run: RpcSchema.unary({
            desc: `种入最小可用数据：opencode-go 模型配置（$VAR 占位）+ 缺省人物（缺省模型：free 优先 → 退 ${FALLBACK_MODEL}）+ 示例项目与任务`,
            input: {},
            output: SeedReportSchema,
          }),
        },
      }),

      facts: RpcSchema.group({
        desc:
            `项目级事实库（##404）：agent **只经这里读写事实，不碰 YAML 文件**（手改必错）。真源 knowledge/facts/*.yaml，判据在 @diy-agent/facts。` +
            `\n\n**不知道一件东西该去哪查 → \`diy facts brief where\`**：\`where\` 主题是「统一汇入点」，每个通道（facts / runtime / journal / traffic / 文件）一条，只写"去哪查"、不写值（通道才变，所以不腐坏）`,
        children: {
          status: RpcSchema.unary({
            desc: `事实库体检：条目 / claim / 词表计数 + 全部问题（与 ./sha.sh check 同一套判据，不会出现"CLI 绿、CI 红"）。顶层计数 = **本根**，额外只读库（设备级）单列在 \`extra\` —— 混一桶会造出"我啥也没干库就暴涨"的假象`,
            input: {
              dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
              in: z
                .string()
                .optional()
                .cliOption({ desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）" }),
            },
            output: FactsStatusSchema,
          }),
          brief: RpcSchema.unary({
            desc: `目录级：列若干 subject 的**全部 aspect**（gid + 值首句 ≤80 字）。链上正文删掉后靠它"扫一眼有哪些条目"，再决定精确 \`get\` 哪条。**多个主题用逗号**、**通配 \`app.*\` 展开全部同前缀主题**（kb 索引按前缀折叠后，展开就靠这一条命令）—— 一次调用搞定，省下的是一整轮前缀重发。元数据只给**异常态**（review≠accepted / lifecycle≠active / variants>1），同源时 \`file\` 提到主题级`,
            input: {
              subject: z.string().cliArg({ placeholder: "<subject,...>", desc: "主题（如 find / tool / rule；多个用逗号分隔）" }),
              maxChars: z.number().optional().cliOption({ desc: "每条摘要字数上限（缺省 80）" }),
              budget: z
                .number()
                .optional()
                .cliOption({
                    desc: "总字节上限（UTF-8，按**最终输出的 JSON** 量，含 budget/truncated/notes 回执）：按主题序 → aspect 序**逐条贪心装**，装不下就停（余下记 `truncated`）。利用率接近 100%，不再有「整主题砍」的断崖；一条都装不下时给 `notes` 说明最小单元与建议值",
                }),
              dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
              in: z
                .string()
                .optional()
                .cliOption({ desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）" }),
            },
            output: FactsBriefSchema,
          }),
          find: RpcSchema.unary({
            desc: `全文检索：claim / id / value 上大小写不敏感子串，多个关键词用逗号分隔 = **全都要命中**。命中内容排在命中键名之前`,
            input: {
              keyword: z.string().cliArg({ placeholder: "<关键词,...>", desc: "关键词（多个用逗号分隔 = 与）" }),
              limit: z.number().optional().cliOption({ desc: "最多返回几条（缺省 20；total 不受影响）" }),
              maxChars: z.number().optional().cliOption({ desc: "每条摘要字数上限（缺省 80）" }),
              dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
              in: z
                .string()
                .optional()
                .cliOption({ desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）" }),
            },
            output: FactsFindSchema,
          }),
          get: RpcSchema.unary({
            desc: `按 claim（subject#aspect）取当前作用域下的值；多个 claim 用逗号分隔。悬空 / 冲突带错误码返回，**不当成"没找到"**`,
            input: {
              claim: z.string().cliArg({ placeholder: "<subject#aspect>", desc: "claim（多个用逗号分隔）" }),
              env: EnvSchema.optional().cliOption({ desc: "作用域：环境（production|development|test）" }),
              path: z.string().optional().cliOption({ desc: "作用域：代码路径（多个用逗号分隔，仓库相对）" }),
              task: z.string().optional().cliOption({ desc: "作用域：任务 URI" }),
              dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
              in: z
                .string()
                .optional()
                .cliOption({ desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）" }),
            },
            output: FactsGetSchema,
          }),
          submit: RpcSchema.unary({
            desc: `整批写入事实（**全过才写**：一条不过整批拒，磁盘不动）。**库不存在 = 空库，直接写**：目录由落盘层顺手建出（\`report.created = { dir }\` 即"本批新建了库"，\`--dir\` 手敲路径写错时靠它发现）。载荷 JSON \`{ facts: [...], subjects?: [...], drop?: [...], expose?: {<subject>: full|index|none} }\`（field 值为 - 读 stdin）；--dry-run 只回显差异。\`expose\` = 主题暴露档与事实**同一事务**（改档位也别手改 YAML）：\`full\` 进正文 / \`index\` 只进索引（缺省）/ \`none\` 两处都不给；\`full\` 的字节和超预算 ⇒ 整批拒写（不许沉默超限）。\`drop\` = 物理删除的 id，与写入**同批事务** —— 改名 = \`drop\` 旧 id + 写新 id + 补 supersedes 边，一次成型（分成两次 = 中间态悬空边或断头事实）；删完照样跑整套判据，删错了以「边悬空」当场拒写\n\n**四种载荷各自的形状**（字段名写错当场拒，不再崩在内部）：\n· facts[] = { subject, aspect, value, format?, review?, lifecycle?, scope?, refs?, evidence } —— \`format\` 缺省 \`md\`（不必写，值是 md 文本，表格/列表随便写）；只有**机器消费**的值才写 \`format: json\`（submit 当场 JSON.parse 校验，写错逗号即拒，错误码 facts/value-format）；evidence = { source: user|probe|code|inference, at?, quote?, probe?, probeDigest?, verifiedAt? } —— at 有**两**种写法：<路径>:<行>（默认，行号随文件漂）/ **<rev>:<路径>:<行>（钉住提交：行号在该 rev 里校验，源文件后续瘦身不影响）** —— 迁移类事实一律用后者；行可省；**source: probe 用 probe（探针命令）而不是 at**（探针没有文件行号可指，可不写 at）\n· subjects[] = { key, description?, aliases? } —— 字段名是 **key**（不是 subject / name / id）；每个 subject 必须有 description\n· drop[] = fact id 字符串（物理删事实；改名 = drop 旧 id + 写新 id + 补 supersedes 边）\n· dropSubjects[] = subject key 字符串（删**本地**词表条目；删不掉的三种情况各有错误码：仍被事实用 → facts/subject-drop-in-use · 继承来的 → facts/subject-drop-not-local · 同批既声明又删 → facts/subject-drop-declared）\n· expose = { \"<subject>\": full|index|none }\n\n**事务边界**：四种载荷 + facts 的 schema 校验**任一不过 ⇒ 磁盘一个字都不动**（含词表）。返回 \`problems\` 里带错误码，重提即可 —— 不会有\"事实没写进去、词表却多了一行\"的半截状态。`,
            input: {
              file: z.string().cliOption({ readFile: true, placeholder: "<file|->", desc: "载荷 JSON 文件（- = stdin）" }),
              dryRun: z.boolean().optional().cliOption({ desc: "只算不写：回显将新增 / 修改什么" }),
              dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省：DIY_FACTS_DIR > **调用方 cwd** 向上找 > 主进程 cwd）" }),
              /**
               * 调用方 cwd（parser 自动注入，不是可敲的选项）—— 缺省库目录的**判据**（##437）。
               * handler 跑在 app 主进程，`process.cwd()` 是应用目录（主仓）：用它当缺省
               * 会让 worktree 里的 `facts submit` 写进主仓（##408）。
               */
              cwd: z.string().optional().cliOption({ callerCwd: true }),
              in: z
                .string()
                .optional()
                .cliOption({ desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）" }),
            },
            output: FactsSubmitSchema,
          }),
          raw: RpcSchema.unary({
            desc: `真源**原文**（UI「原 YAML」视图用）：不解析不校验，读什么给什么 —— 包括注释与字段顺序`,
            input: {
              dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
              in: z
                .string()
                .optional()
                .cliOption({ desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（词表继承仓库）" }),
            },
            output: FactsRawSchema,
          }),
          project: RpcSchema.unary({
            desc: `**投影**：真源 → 给 LLM 看的形态（变体解析成当前值 / 按 ns 分组 / 可换算法 / 可按字节预算裁剪）`,
            input: {
              algorithm: z.enum(["yaml-nested", "flat-gid", "md-list"]).optional().cliOption({ desc: "渲染算法（缺省 yaml-nested）" }),
              maxBytes: z.number().optional().cliOption({ desc: "字节预算（超了按 ns 优先级从尾部裁，不截断单条）" }),
              env: EnvSchema.optional().cliOption({ desc: "解析上下文：环境（缺省不假设）" }),
              path: z.string().optional().cliOption({ desc: "解析上下文：代码路径（逗号分隔）" }),
              task: z.string().optional().cliOption({ desc: "解析上下文：任务 URI" }),
              includeProposed: z.boolean().optional().cliOption({ desc: "把 proposed（未 accepted）也算进来" }),
              dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
              in: z
                .string()
                .optional()
                .cliOption({ desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（词表继承仓库）" }),
            },
            output: FactsProjectSchema,
          }),
          affected: RpcSchema.unary({
            desc: `影响面：哪些事实的 scope.paths 覆盖这些文件（动代码前先问一句，比读整份文档便宜）`,
            input: {
              files: z.string().cliOption({ placeholder: "<path,...>", desc: "文件路径（逗号分隔，仓库相对）" }),
              dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
              in: z
                .string()
                .optional()
                .cliOption({ desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）" }),
            },
            output: FactsAffectedSchema,
          }),
        },
      }),

      docs: RpcSchema.group({
        desc: `仓库文档索引（##404）：\`docs/\` 不在任何 AGENTS.md 链上，agent 不知道有哪些设计稿。上下文变量树里只有**摘要**（根 / 篇数 / 最新改动日），逐篇索引**按需**在这里取`,
        children: {
          index: RpcSchema.unary({
            desc: `列出文档索引（一行一篇：路径 / 标题 / 字节 / 状态词 / 两个日期）。缺省只扫 \`docs/plans\`。\n\n**两个日期都给**：docDate 是文档**自述**（文件名 / 标题），touched 是 git 最后改动日 —— 实测一批计划的 git 日期全被一次全局重排刷成同一天，与自述不符。**不一致本身就是信号**（"文档说 7-10，实际 7-19 改过"），只信 git 会得出假结论。\n\nstatus 是**启发式**：只认开篇引用块里「状态 / 结论 / 实现状态：…」那句，抽不到就不给 —— 编出来的状态比没有更坏。读正文用 \`diy tool read <path>\``,
            input: {
              dir: z.string().optional().cliOption({ desc: "仓库根（缺省 = 当前目录；相对路径按当前目录解析）", resolvePath: true }),
              roots: z.string().optional().cliOption({ desc: "扫描根（仓库相对，逗号分隔；缺省 docs/plans，可给 docs 扩到全量）" }),
              max: z.number().optional().cliOption({ desc: "最多返回几篇（缺省 60，按路径序截断）" }),
            },
            output: DocsIndexSchema,
          }),
        },
      }),

      journal: RpcSchema.group({
        desc: `任务日志（##404）：**append-only 事件流**（decision / pitfall / review / progress / learn）。三分法：能改写成「现在是什么」→ \`diy facts\`；「接下来做什么」→ 任务 body；「发生过什么」→ 这里。日志不参与每轮上下文，所以 body 可以瘦`,
        children: {
          add: RpcSchema.unary({
            desc: `追加一条日志（只追加、不改不删；title 一行必填 —— 标题写不出多半是该拆）`,
            input: {
              task: z.string().cliArg({ placeholder: "<projects/N/tasks/M>", desc: "任务 URI（**必填，不做「当前任务」推导**）" }),
              kind: z.enum(["decision", "pitfall", "review", "progress", "learn"]).cliOption({ desc: "kind：decision 决策 / pitfall 踩坑 / review 结论 / progress 里程碑 / learn 发现（**传英文值**，中文只是说明）" }),
              title: z.string().cliOption({ placeholder: "<text>", desc: "一行标题（标题写不出 = 这条该拆）" }),
              body: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<text>",
                  inlineText: { fileOpt: "--body-file", textOpt: "--body-text" },
                  desc: "可选正文（**内联**，不是文件路径：值形如单行路径会被拒）",
                }),
              bodyText: z
                .string()
                .optional()
                .cliOption({ placeholder: "<text>", desc: "可选正文（显式内联，与 --body 同义但不做路径护栏）" }),
              bodyFile: z
                .string()
                .optional()
                .cliOption({ readFile: true, placeholder: "<file|->", desc: "可选正文来自文件（- = stdin）" }),
              refs: z.string().optional().cliOption({ placeholder: "<a,b>", desc: "引用：commit / 任务 uri / 事实 gid / 路径:行（逗号分隔）" }),
              round: z.string().optional().cliOption({ desc: "会话轮次 id（可选）" }),
              author: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<role[:name]>",
                  desc: "谁写的：system（客观判定）/ agent:<名>（模型叙述）/ human:<名>（用户原话，**必须配 --anchor**）",
                }),
              anchor: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<type:...>",
                  desc: "指向哪：node:<id> / message:<id> / task-field:<field> / doc-range:<rev>:<offset>:<quote>",
                }),
            },
            output: JournalAddSchema,
          }),
          raw: RpcSchema.unary({
            desc: `日志文件**原文**（UI「原 JSONL」视图用）：只读字节、只数行 —— 坏行也照原样给出来`,
            input: {
              task: z.string().cliArg({ placeholder: "<projects/N/tasks/M>", desc: "任务 URI" }),
            },
            output: JournalRawSchema,
          }),
          find: RpcSchema.unary({
            desc: `查日志（缺省最近优先、全 kind）。\`--grep\` 搜 title/body/refs；输出是渲染好的 markdown`,
            input: {
              task: z.string().cliArg({ placeholder: "<projects/N/tasks/M>", desc: "任务 URI" }),
              kind: z.string().optional().cliOption({ placeholder: "<k1,k2>", desc: "筛选 kind（逗号分隔）" }),
              since: z.string().optional().cliOption({ placeholder: "<date>", desc: "起始时间（含）" }),
              until: z.string().optional().cliOption({ placeholder: "<date>", desc: "截止时间（含）" }),
              grep: z.string().optional().cliOption({ placeholder: "<text>", desc: "子串过滤（title/body/refs）" }),
              limit: z.number().optional().cliOption({ desc: "最多几条（缺省 20，-1 = 全部）" }),
              order: z.enum(["asc", "desc"]).optional().cliOption({ desc: "排序（缺省 desc = 最近优先）" }),
            },
            output: JournalFindSchema,
          }),
          stats: RpcSchema.unary({
            desc: `日志体检：总条数 / 字节 / 按 kind 计数 / 首尾时间（body 瘦身前后用它对账）`,
            input: {
              task: z.string().cliArg({ placeholder: "<projects/N/tasks/M>", desc: "任务 URI" }),
            },
            output: JournalStatsSchema,
          }),
          import: RpcSchema.unary({
            desc: `批量导入（回灌历史）。载荷 = JSON 数组 \`[{kind,title,body?,refs?,ts?}]\`；**整批校验通过才写**，--dry-run 只算`,
            input: {
              task: z.string().cliArg({ placeholder: "<projects/N/tasks/M>", desc: "任务 URI" }),
              file: z.string().cliOption({ readFile: true, placeholder: "<file|->", desc: "载荷 JSON（- = stdin）" }),
              dryRun: z.boolean().optional().cliOption({ desc: "只算不写" }),
            },
            output: JournalImportSchema,
          }),
        },
      }),

      flow: RpcSchema.group({
        desc: `工作流实例（与任务绑定；状态真源 = 任务目录 flow/state.json，见 ##319）`,
        children: {
          list: RpcSchema.unary({
            desc: `列出可用工作流定义（--instances 改为扫盘列出已绑定的实例）`,
            input: {
              instances: z.boolean().optional().cliOption({ desc: "改为列出各任务上的实例（含位置）" }),
            },
            output: z.object({
              workflows: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  entry: z.string(),
                  nodes: z.number(),
                  edges: z.number(),
                }),
              ),
              instances: z
                .array(
                  z.object({
                    uri: z.string(),
                    workflowId: z.string(),
                    position: z.string().nullable(),
                    error: z.string().optional(),
                  }),
                )
                .optional(),
            }),
          }),

          show: RpcSchema.unary({
            desc: `看实例：当前节点 + 折线 + 出边 + 参数值（含 state.json 与 path.jsonl 的对账，不一致即报）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
            },
            output: FlowViewSchema,
          }),

          view: RpcSchema.unary({
            desc: `取某个节点、某次驻留的产物视图（袋里的 raw → render 插件 → { renderer, payload }）。缺省 = 当前节点的最后一次驻留 —— UI 点折线上任意一步看图靠它`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
              node: z.string().optional().cliOption({ desc: "节点 id（缺省 = 当前节点）" }),
              seq: z.number().optional().cliOption({ desc: "第几次驻留（1-based；缺省 = 该节点最后一次）" }),
            },
            output: FlowArtifactViewSchema,
          }),

          artifact: RpcSchema.group({
            desc: `节点产物的**写入**（袋 = 任务目录 flow/artifacts/<节点 id>.json，下标 = 驻留 seq − 1；读走 \`flow view\`）`,
            children: {
              put: RpcSchema.unary({
                desc: `放一份产物 raw 进袋（写前**先试译一次**：译不出来一个字节都不写）。内容能当 JSON 解析就是那个值，否则原样当字符串`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
                  node: z.string().cliOption({ desc: "节点 id（产物属于哪个节点）" }),
                  seq: z.number().optional().cliOption({ desc: "第几次驻留（1-based；缺省 = 该节点最后一次）" }),
                  file: z
                    .string()
                    .cliOption({
                      placeholder: "<file|->",
                      readFile: true,
                      desc: "产物内容：文件路径（相对路径按当前目录解析），`-` 读 stdin。JSON 能解析就用那个值，否则当字符串",
                    }),
                },
                output: FlowArtifactViewSchema,
              }),
            },
          }),

          thread: RpcSchema.group({
            desc: `打回**讨论线程**（##342）：锚点 = 折线上**真发生过的一次打回边**（不造数据）—— 旁注 / 留痕，不参与驱动判据（删了不影响推进）`,
            children: {
              list: RpcSchema.unary({
                desc: `列讨论线程（真打回边 ∪ 讨论流锚点）：每条线程 = 一个锚点 + 它的发言（append-only）。\`--thread\` 只看那一条`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
                  thread: z.string().optional().cliOption({ desc: "只看这条线程（形如 review->implement#2）；缺省列全部" }),
                },
                output: FlowThreadsSchema,
              }),
              post: RpcSchema.unary({
                desc: `往线程里发一条言（三出口里的 resolved / escalate 都走它）。**锚点必须在折线上確有那次打回**（假锚点拒）；正文空 ⇒ 拒`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
                  thread: z.string().cliOption({ desc: "线程 id（形如 review->implement#2，见 \`flow thread list\`）" }),
                  text: z
                    .string()
                    .cliOption({
                      placeholder: "<file|->",
                      readFile: true,
                      desc: "发言正文：文件路径（相对路径按当前目录解析）或 `-` 读 stdin",
                    }),
                  type: z
                    .enum(["note", "resolved", "escalate"])
                    .default("note")
                    .optional()
                    .cliOption({ desc: "note=普通发言（缺省）/ resolved=宣布线程已解决（位置不动）/ escalate=升级人裁决" }),
                  author: z.string().optional().cliOption({ desc: "发言作者（缺省 cli；升级人裁决常写 human）" }),
                },
                output: FlowThreadsSchema,
              }),
            },
          }),

          start: RpcSchema.unary({
            desc: `建实例：绑定工作流 + 参数值过内核闸门（**不自动进入**入口，首次 advance 才进入；已有**未进入**实例会被重写，已进入则拒 —— 换工作流/换配置 = 另起一次运行）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              workflow: z.string().optional().cliOption({ desc: "工作流 id（见 `diy flow list`）" }),
              param: kvList().optional().cliOption({ desc: "参数值 `节点 id.局部名=值`（缺省用声明里的 default）" }),
            },
            output: FlowViewSchema,
          }),

          finish: RpcSchema.unary({
            desc: `收尾：宣布实例已走完（置 done）。**只允许在结构终端节点上**（没有 next 出边）；guard 那一半由宣布者担责（prompt: 不可观测）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              note: z.string().optional().cliOption({ desc: "审计正文的后缀备注（不参与领域态）" }),
            },
            output: FlowViewSchema,
          }),

          advance: RpcSchema.unary({
            desc: `推进：走 next 边（首次 = 进入入口节点；不许跳步）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              to: z.string().optional().cliOption({ desc: "目标节点 id" }),
              ref: kvList().optional().cliOption({ desc: "宿主关联（写进 Visit.ref）" }),
              note: z.string().optional().cliOption({ desc: "审计正文的后缀备注（不参与领域态）" }),
            },
            output: FlowViewSchema,
          }),

          bounce: RpcSchema.unary({
            desc: `打回：走 bounce 边（目标节点再驻留一次，不新建节点）。带 \`--opinion\` 时把**意见正文**一等落进讨论流（挂这次打回的锚点）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              to: z.string().optional().cliOption({ desc: "目标节点 id" }),
              ref: kvList().optional().cliOption({ desc: "宿主关联（写进 Visit.ref）" }),
              note: z.string().optional().cliOption({ desc: "审计正文的后缀备注（不参与领域态）" }),
              opinion: z
                .string()
                .optional()
                .cliOption({
                  placeholder: "<file|->",
                  readFile: true,
                  desc: "意见正文（##342）：落进讨论流并挂在这次打回的锚点上；文件路径或 `-` 读 stdin。缺省只落审计后缀（--note）",
                }),
              author: z.string().optional().cliOption({ desc: "发言作者（缺省 cli；驱动环起的轮次用 agent 标识）" }),
            },
            output: FlowViewSchema,
          }),

          params: RpcSchema.group({
            desc: `实例参数值（权威 = flow/state.json）`,
            children: {
              get: RpcSchema.unary({
                desc: `看参数值 + 参数声明（供表单 / 文档渲染）`,
                input: { uri: z.string().cliArg({ desc: "任务 URI" }) },
                output: z.object({
                  uri: z.string(),
                  workflowId: z.string(),
                  workflowName: z.string(),
                  authority: z.string().describe("权威文件（state.json 的绝对路径）"),
                  entered: z.boolean(),
                  values: z.record(z.string(), z.any()),
                  schema: z.array(z.any()),
                  defaults: z.record(z.string(), z.any()),
                }),
              }),
              set: RpcSchema.unary({
                desc: `改参数值（**只在尚未进入时**允许：换配置 = 另起一次运行）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                  param: kvList().optional().cliOption({ desc: "新的参数值（未给的项回落声明里的 default）" }),
                },
                output: FlowViewSchema,
              }),
            },
          }),

          prompt: RpcSchema.unary({
            desc: `按当前节点装配提示词（hint 内核插值 + 既有 prompt-registry 渲染；只读）`,
            input: { uri: z.string().cliArg({ desc: "任务 URI" }) },
            output: z.object({
              uri: z.string(),
              workflowId: z.string(),
              nodeId: z.string(),
              nodeName: z.string(),
              hint: z.string().describe("插值后的节点提示（内核 renderHint）"),
              prompt: z.string().describe("装配结果（prompt-registry 渲染的节）"),
              bytes: z.number(),
            }),
          }),
          /**
           * ##341 起 flow 域多两条**驱动**命令（一个系统推、一个自动轮转）。
           * 与既有命令的分别：`advance` / `bounce` 是**宣布**（不评价 guard），它们走内核的**求值**那条路。
           */
          step: RpcSchema.unary({
            desc: `系统推一步：当前节点 guard 全可观测 ⇒ 真求值（pred:/action:）并自动推进；尚未进入 ⇒ 进入入口。含 prompt: 的节点一步都不推（返回 awaiting-actor）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              cwd: z.string().optional().cliOption({ desc: "命令类插件（pred:/action:）的工作目录；缺省 = 应用进程 cwd" }),
            },
            output: z.object({
              status: z.enum(["moved", "done", "stuck", "awaiting-actor"]).describe("moved=推成了 / done=走完 / stuck=停在边上 / awaiting-actor=这一步要 actor 宣布"),
              to: z.string().nullable(),
              kind: z.enum(["entry", "next", "bounce"]).nullable(),
              reason: z.string().describe("stuck / awaiting-actor 的原因（其余为空串）"),
              view: FlowViewSchema,
            }),
          }),
          run: RpcSchema.serverStream({
            desc: `驱动环（##341）：按 next.mode 三分流自动轮转 —— system 真求值自动推（绿线）· actor+agent 起一轮 agent 收结论后推进/打回 · actor+human 停下等人。**客户端断开即中断**（可停）；判据一律读 flow show（幂等，重复 run 接着走）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              maxSteps: z.number().optional().cliOption({ desc: "步数护栏（缺省 32）" }),
              cwd: z.string().optional().cliOption({ desc: "命令类插件的工作目录；缺省 = 应用进程 cwd" }),
            },
            output: z.string().describe("逐行 JSON 帧：{kind:'step'|'turn'|'stop', …}（给人看的输出，不是真源）"),
          }),
        },
      }),

      /**
       * 后台 job（##408 v1：只有 spawned 型 —— 会话里跑出来的长时命令）：
       * 定义在哪（哪个任务/轮/工具调用）、跑了多久、怎么结束的、输出尾巴。
       *
       * **只读**：本刀不做「运行 / 停用 / 取消」（刀 6 起接），故没有 run/cancel 子命令。
       */
      job: RpcSchema.group({
        desc: `后台 run 的管理（**\`job\` = 后台活的总称，本域装的唯一实体是 run**；只管 \`background\` 起的长活，前台命令不登记 —— 见 ##408 刀 16）`,
        children: {
          ps: RpcSchema.unary({
            desc: `
            **在跑什么**（活体表，刀 8 起）：后台 run 的当前快照 —— 不是历史账。

            返回 runs（运行中的在前，同状态按启动时间倒序）· running（在跑几条）· total。
            每行含：state/stateLabel · pid（null = 没起来或非进程型）· title · **command（原始命令行全文）** ·
            cwd · startedAt/endedAt · durationText · exitCode/signal/exitText · outputBytes/outputText ·
            origin/originText（哪个任务/轮/步/工具调用起的）· logPath · dir。
            `,
            input: {
              all: z
                .boolean()
                .optional()
                .cliOption({ desc: "也列出已结束的（缺省只列运行中；app 退出后表即空 —— 这是刻意的，不做恢复）" }),
              noScan: z
                .boolean()
                .optional()
                .cliOption({ desc: "不扫 ps（跳过「未登记」进程那一列；缺省扫）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }),
          }),
          detachables: RpcSchema.unary({
            desc: `
            **现在能转后台的前台调用**（##408 刀 21）：哪条工具调用还跑着、已经跑了多久。

            只列**本任务**、**还在跑**、**拿得到 toolCallId** 的前台 bash —— 三项缺一就不列
            （转不了的按钮不如没有）。转完就从这里消失，去 \`job.ps\` 里看它。
            `,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI（只看这个任务的）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }),
          }),
          detach: RpcSchema.unary({
            desc: `
            把一条**还在跑的前台命令**转成后台 run（对应 opencode 的 \`ctrl+b\`）。

            语义：**不重启进程、不丢前半段输出** —— 只换"谁在等"和"输出写到哪"。
            转成功后工具调用立刻返回 \`[已转后台] <runId>\`，模型据此去 \`job status\`；
            结束时会照常插话唤醒。拒绝是**正常时序**不是缺陷：命令恰好结束了（\`agent/job-already-ended\`）、
            已经转过了（\`agent/job-not-found\`）、不属于这个任务（\`agent/job-foreign\`）。
            `,
            input: {
              toolCallId: z.string().cliArg({ desc: "工具调用 id（`job.detachables` 里给的）" }),
              taskUri: z.string().cliArg({ desc: "任务 URI（**必填**：属主对不上就拒，见 `job-fence`）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
          procs: RpcSchema.unary({
            desc: `
            **这台 app 起过、现在还在的全部进程**（ps 现扫，不只我们登记过的）。

            为什么要它：模型可以在命令里写 \`nohup xxx & \` —— 那种进程从没经过活体表，
            但归我们管（按**进程组**认领，见 \`shared/proc-scan.ts\`）。这里把它一并列出来，
            回答「我起的那些东西现在到底有哪些在跑」。
            `,
            input: {
              scan: z.boolean().optional().cliOption({ desc: "预留：是否重扫（当前恒重扫，ps 一次约几十毫秒）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }),
          }),
          killproc: RpcSchema.unary({
            desc: `
            结束一条**未登记**的进程（按 pid；同组且组不是 app 自己时按组杀）。

            两道闸都过才动手：① 调用时**重新扫一遍** ps，pid 不在"归我们管"的名单里就拒绝；
            ② 归属校验（\`shared/job-fence.ts\`）—— 你声明的 \`taskUri\` 必须与组名册 / run origin
            记下的归属一致，否则拒绝（跨任务不代杀；归属不明的也不动，请用 ps / kill 手工来）。
            `,
            input: {
              pid: z.number().cliArg({ desc: "进程 pid（`diy job procs` 里看到的）" }),
              taskUri: z.string().cliArg({ desc: "任务 URI（**必填**：这个 pid 归哪个任务）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
          kill: RpcSchema.unary({
            desc: `
            停止一条 run（进程型按**进程组** SIGTERM → 2s → SIGKILL）。返回是否真的发出了停止。

            \`taskUri\` **必填**：这条 run 的 \`origin.taskUri\` 必须与它一致（\`shared/job-fence.ts\`）。
            跨任务不代杀 —— kill 是按组发的，认错一次带走的是整组无关进程。
            `,
            input: {
              id: z.string().cliArg({ desc: "run id（形如 r-mvlmxmuf-qxmr：r-<base36 毫秒>-<4 位随机>，用 diy job ps 查）" }),
              taskUri: z.string().cliArg({ desc: "这条 run 属于哪个任务（`job.ps` 每行的 `taskUri`）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
          tail: RpcSchema.unary({
            desc: `读一条 run 的输出尾部（从它自己的 out.log 读；给了 lines 就按行切，同时受 16KB 字节上限）。`,
            input: {
              id: z.string().cliArg({ desc: "run id" }),
              lines: z.number().optional().cliOption({ desc: "要最后几行（缺省 40）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
          meta: RpcSchema.unary({
            desc: `看一条 run **实际落盘的东西**：meta.json 原文 + out.log 路径/字节数 + 目录（面板「存储数据」tab 用）。`,
            input: {
              id: z.string().cliArg({ desc: "run id" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
        },
      }),

      log: RpcSchema.group({
        desc: `日志`,
        children: {
          read: RpcSchema.unary({
            desc: `读取日志`,
            input: {
              limit: z.number().optional().cliOption({ desc: "返回条目数" }),
            },
            output: z.array(z.object({
              timestamp: z.string().optional(),
              level: z.string().optional(),
              message: z.string().optional(),
              raw: z.string().optional(),
            })),
          }),
        },
      }),

      /**
       * 实例大盘（Main 域）——「本机现在有哪些 diy 实例在跑、各自是谁、在干什么」。
       *
       * 发现靠**扫进程**（没有实例索引，见 services/instances.ts 文件头），
       * 「谁开的」靠启动时写进注册表（`~/.diy-instances/<pid>.json`，事后再追父链追不出来），
       * 数据根/端口靠**活体自报**（环境变量是继承来的，不等于真根）。
       */
      instances: RpcSchema.group({
        desc: `实例大盘（扫描本机 diy 实例 + 唤起指定实例）`,
        children: {
          ls: RpcSchema.unary({
            desc: `列出本机所有 diy 实例（对齐表格文本，供人读；程序读请用 instances.list）`,
            input: {},
            output: z.string().describe("表格文本（含表头与汇总行）"),
          }),
          list: RpcSchema.unary({
            desc: `列出本机所有 diy 实例（结构化行，供 UI / 程序消费）`,
            input: {},
            output: z.object({ rows: z.array(InstanceRowSchema) }),
          }),
          self: RpcSchema.unary({
            desc: `本实例自报身份 + 活跃会话 + 窗口状态（别的实例扫描时调用；无窗口实例 window=null）`,
            input: {},
            output: InstanceSelfSchema,
          }),
          reveal: RpcSchema.unary({
            desc: `唤起**本**实例窗口（重建 + 前置 + 全屏；由别的实例的 instances.focus 调用）`,
            input: {},
            output: RevealResultSchema,
          }),
          focus: RpcSchema.unary({
            desc: `
            唤起指定实例（窗口前置 + 全屏）

            主路 = 让目标实例**自己** show+focus+setFullScreen（RPC，确定且无需系统权限）；
            RPC 不可用（无端口 / 无响应）时降级到**系统级唤起**（平台支持时才可用；macOS 上需 Automation 权限，可能弹窗）。
            两路都失败即报错 —— 不静默吞。
            `,
            input: {
              pid: z.number().optional().cliOption({ desc: "目标实例 pid（与 --port 二选一）" }),
              port: z.number().optional().cliOption({ desc: "目标实例 RPC 端口（与 --pid 二选一）" }),
            },
            output: z.object({
              pid: z.number().nullable(),
              port: z.number().nullable(),
              via: z.string().describe("rpc（目标实例自己唤起）| system（系统级降级）"),
              reason: z.string(),
            }),
          }),
        },
      }),

      /**
       * 文件系统变更推送（Main 域）。
       *
       * ⚠️ 必须在 diy.* 而非 diy.ui.*：实现是 main 侧的 FileWatcher（renderer 只是订阅方），
       * 而 rpc-port 会把 `diy.ui` 整棵子树 onForward 给 renderer —— 挂在 ui 下会让同一方法
       * 被注册两次（本地 + 转发），ServerBinding 直接抛「已注册」使 RPC 服务器起不来。
       * 判据：diy.* = Main 本地处理，diy.ui.* = 转发 Renderer（见本文件头注释）。
       */
      watch: RpcSchema.group({
        desc: `文件系统监控（projects/ 增删改 → 实时推送）`,
        children: {
          fileChange: RpcSchema.serverStream({
            desc: `文件变更事件流 — 持续订阅，FileWatcher 检测到 projects/ 下文件变更后 yield`,
            input: {},
            output: z.object({
              event: z.string().describe("变更类型：task-change（projects/ 下任务树相关变更）"),
              ts: z.number().describe("变更发生时间戳（ms）"),
            }),
          }),
        },
      }),

      /**
       * 「模型不可用」通知（##369 ①）。Main 本地域（判据在 main 侧：只有真发失败的那一刻
       * 才拿得到状态码与上游原文），renderer 订阅 `watch` 出顶栏 bar。
       *
       * 数据定性 = cache（进程内存 ring，重启即空）：它描述"此刻有什么坏了"，不是历史账；
       * 追溯去看会话流与 ~/.diy/log/network/*.jsonl。
       */
      notice: RpcSchema.group({
        desc: `模型不可用通知（真发失败时产生；含人物 + 模型 + 上游原文）`,
        children: {
          /** 未关闭的通知，时间升序（CLI `diy notice list` 直接读它） */
          list: RpcSchema.unary({
            desc: `列出当前未关闭的「模型不可用」通知`,
            input: {},
            output: z.array(ModelUnavailableNoticeSchema),
          }),
          /**
           * 关闭 = "我知道了"：从 ring 移除，此后重连不再回放。
           * 为什么必须落 main 侧：只关界面的话，下一次重连的回放会把同一条又推回来 ——
           * 用户点了 ✕ 却关不掉的提示等于没关（bar 上"可关闭"是硬要求）。
           * 不给 id = **全关**（bar 一次只展示最新一条，点 ✕ 的语义就是"这波我都知道了"）。
           */
          dismiss: RpcSchema.unary({
            desc: `关闭通知（给 id 关一条；不给 = 全部关闭）`,
            input: { id: z.string().optional().cliArg({ desc: "通知 id（缺省 = 全部关闭）" }) },
            output: StatusOk,
          }),
          /**
           * 通知流：**订阅即回放**当前未关闭的通知，之后是增量。
           * 回放是刻意的：页面重载 / 断线重连后 bar 要能自己回来（用户重开窗口正是最容易
           * 错过提示的时刻），所以"当前事实"必须随订阅给全，而不是只推增量。
           */
          watch: RpcSchema.serverStream({
            desc: `通知流（订阅回放现存 + 增量推送；顶栏 bar 的数据源）`,
            input: {},
            output: ModelUnavailableNoticeSchema,
          }),
          /**
           * 通知信箱（##429 要求 ④/⑤ + ##436 的界面）：`level#inbox` 的「N1/N2 一律落信箱」。
           *
           * 条目种类（`shared/inbox.INBOX_KINDS`）：`max-tokens` / `cost-step` / `cost-turn`
           * （损失型，##429）· `message`（有留言投给某会话，##436：人署名 N2 / 机器 N1）·
           * `lost`（**任务已结案而插话队列里还压着留言** ⇒ 不会有下一次轮次来取走它；
           * 启动扫尾写入，不许静默。文案必须写明「改回 active 就会生效」——它是可逆的）。
           *
           * 与上面 `list/dismiss/watch`、下面 `env.*` 的关键差别是**数据定性**：那些是 cache
           * （进程内存 ring，重启即空 —— 描述“此刻怎么了”）；这里是 **append-only 落盘**
           * （`$DIY_HOME/local/inbox.jsonl`）—— 它描述“发生过什么”，重启后回看正是它的主要用途。
           *
           * 订阅语义刻意不同：`watch` **只推增量、不回放**。回放的历史条目会在 renderer 里
           * 被当成“刚发生”再弹一轮 toast（每次窗口重载糊一脸）；要回看走 `list`。
           */
          inbox: RpcSchema.group({
            desc: `通知信箱（落盘流水：撞输出上限 / 成本过阈 / 新留言 / 结案任务的滞留留言；可回看）`,
            children: {
              list: RpcSchema.unary({
                desc: `列出信箱条目（时间升序；按任务可筛。人读用 diy notice inbox list）`,
                input: {
                  taskUri: z.string().optional().cliOption({ desc: "只看该任务的条目" }),
                  limit: z.number().optional().cliOption({ desc: "只要最近 N 条（缺省全部，上限 200）" }),
                },
                output: z.array(InboxEntrySchema),
              }),
              watch: RpcSchema.serverStream({
                desc: `信箱增量流（**不回放历史**：订阅后新落的才推；renderer 据此弹 N1 toast）`,
                input: {},
                output: InboxEntrySchema,
              }),
            },
          }),
        },
      }),

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
      env: RpcSchema.group({
        desc: `环境感知通知（磁盘满 / 网断；含数字证据，条件恢复自动消）`,
        children: {
          /** 未关闭的通知（结构化行，供 UI / 程序消费；人读请用 `env ls`） */
          list: RpcSchema.unary({
            desc: `列出当前未关闭的环境通知（结构化行，供 UI / 程序消费）`,
            input: {},
            output: z.array(EnvNoticeSchema),
          }),
          /** 人读视图：对齐表格文本（`diy env ls` 的出口） */
          ls: RpcSchema.unary({
            desc: `列出当前未关闭的环境通知（人读表格；程序读请用 env list）`,
            input: {},
            output: z.string().describe("表格文本（无通知时给一句「环境正常」）"),
          }),
          /**
           * 关闭 = "这个条件我知道了"：从 ring 移除并**静音该类**，条件不变就不再弹。
           * 为什么必须落 main 侧：只关界面的话，下一次轮询（30s 后）会把同一条又推回来 ——
           * 用户点了 ✕ 却 30s 后又弹，等于没关。
           * 不给 id = 全关。条件恢复时静音自动解除（下次再坏要能重新提醒）。
           */
          dismiss: RpcSchema.unary({
            desc: `关闭环境通知（给 id 关一条；不给 = 全部关闭；同类条件不变不再弹）`,
            input: { id: z.string().optional().cliArg({ desc: "通知 id（缺省 = 全部关闭）" }) },
            output: StatusOk,
          }),
          /**
           * 通知流：**订阅即回放**当前未关闭的通知，之后是增量（upsert / resolve 两态）。
           * 回放是刻意的：页面重载 / 断线重连后红条要能自己回来（用户重开窗口正是最容易
           * 错过提示的时刻）。
           */
          watch: RpcSchema.serverStream({
            desc: `环境通知流（订阅回放现存 + 增量；resolve 事件 = 条件已恢复，bar 据此移除）`,
            input: {},
            output: EnvNoticeEventSchema,
          }),
          /**
           * **探针**：注入一条假的环境事实（磁盘水位 / 网络连败）—— **仅非生产环境**。
           *
           * 为什么需要：真造满盘会毁现场数据（2026-10-18 已经毁过 ##166 正文一次），真断网会
           * 打断本机所有实例。注入走的是与真事件**同一条**判据 + 同一个 ring + 同一个 bar，
           * 差别只在事实来源 —— 这是「bar 出现 / 关闭 / 回放 / 多条件堆叠」唯一可复现的活体验证。
           * 生产（`DIY_ENV=production`）一律拒绝：它不是"随手造个假红条"的入口。
           *
           * 用法：
           *   `diy env simulate --disk-avail 1048576 --disk-total 536870912`
           *   `diy env simulate --net-code ENOTFOUND --net-streak 3`
           *   `diy env simulate --disk-avail 200000000000 --disk-total 500000000000`（恢复 → 自动消）
           */
          simulate: RpcSchema.unary({
            desc: `探针：注入假环境事实（磁盘水位 / 网络连败）—— 仅非生产环境；恢复值会触发自动消`,
            input: {
              diskAvail: z.number().optional().cliOption({ desc: "磁盘可用字节数（给出 = 走磁盘分支）" }),
              diskTotal: z.number().optional().cliOption({ desc: "磁盘总字节数（缺省 500GiB）" }),
              diskMount: z.string().optional().cliOption({ desc: "挂载点标签（缺省 = 进程的探测目标）" }),
              netCode: z.string().optional().cliOption({ desc: "网络错误码（给出 = 走网络分支，如 ENOTFOUND）" }),
              netStreak: z.number().optional().cliOption({ desc: "连续失败次数（缺省 = 判据阈值 3；小于阈值 = 不亮）" }),
              netMessage: z.string().optional().cliOption({ desc: "错误消息（展示用）" }),
            },
            output: z.object({ notice: EnvNoticeSchema.nullable() }),
          }),
          /**
           * **探针**：立刻采一次磁盘水位并按判据推通知（不写盘、不填卷）。
           *
           * 为什么要有它：真造满盘会毁现场数据（2026-10-18 已经毁过 ##166 正文一次）。可复现的
           * 验证只有两条路 —— ① 单测注入假 statfs ② 这条 RPC 指向**小容量 hdiutil 镜像**
           * （`DIY_ENV_WATCH_TARGET` 或本参数）。这条命令就是 ② 的入口。
           */
          probe: RpcSchema.unary({
            desc: `立刻探一次磁盘水位并推通知（探针：可指定 path 指向小容量镜像，别填满根卷）`,
            input: {
              path: z.string().optional().cliOption({
                desc: "要探测的路径（缺省 = 进程的 DIY_ENV_WATCH_TARGET 或 /）",
                resolvePath: true,
              }),
            },
            output: z.object({
              sample: z.object({ mount: z.string(), availBytes: z.number(), totalBytes: z.number() }),
              /** 这次探测产出的通知（水位 ok 时 null，且会撤掉已有通知） */
              notice: EnvNoticeSchema.nullable(),
            }),
          }),
        },
      }),

      // ═══════════════════════════════════════════
      //  diy.ui.* — Renderer 进程域
      //  这些服务只在 Renderer 进程（浏览器）中运行。Main 侧经
      //  Main 侧 onForward 转发到 Renderer；Renderer 侧直接本地处理。
      // ═══════════════════════════════════════════
      ui: RpcSchema.group({
        desc: `Renderer 进程域`,
        children: {
          /** 列出当前页面所有可用 UI 组件 */
          component: RpcSchema.group({
            desc: `组件`,
            children: {
              list: RpcSchema.unary({
                desc: `列出 UI 组件`,
                input: {},
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    components: z.array(z.object({
                      name: z.string(),
                      label: z.string(),
                      description: z.string().optional(),
                    })),
                  }),
                }),
              }),

              /** 查询组件当前状态（参数因组件而异） */
              status: RpcSchema.unary({
                desc: `查询组件状态`,
                input: { name: z.string().describe('组件名称') },
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    visible: z.boolean(),
                    state: z.string().optional(),
                  }),
                }),
              }),
            },
          }),

          /**
           * 布局（layout）的读 / 写。
           *
           * 为什么要这个出口：布局的用户态（区段尺寸 / 哪些 area 收起 / 哪个最大化 /
           * 哪些 view 隐藏）原本只活在 renderer 的 localStorage 里，CLI 读不到也改不了 ——
           * 于是「设成某种布局再验证」只能手点，意图测试也只能去数 DOM 像素。
           *
           * 写入的是**偏离默认的那部分**（patch 语义），不是整份文档：
           * 调用方只说自己关心的字段，其余保持用户现值。`reset` 才回到开发者默认。
           *
           * ⚠️ 分层：**几何**（track 尺寸 / area 开合 / 最大化）按 page 共享 —— 所有任务
           * 的 task-run tab 用同一套；**view 的显隐**（hiddenViews）按 page 实例（带 ctx）。
           * 故 get 收 ctx 只为过滤 hiddenViews，set 不收 ctx。
           */
          layout: RpcSchema.group({
            desc: `布局`,
            children: {
              get: RpcSchema.unary({
                desc: `读某 page 实例的布局态（有效值：默认已合并用户覆盖）`,
                input: {
                  page: z.string().cliArg({ desc: "page id（如 task-run / lab / settings）" }),
                  ctx: z.string().optional().cliOption({ desc: "上下文键：把 hiddenViews 过滤到该实例（几何本身按 page 共享）" }),
                },
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    /** 有效布局（开发者默认 + 用户覆盖 + 隐藏 area 的 track 归零） */
                    layout: z.any(),
                    /** 用户态：隐藏的 area / 隐藏的 view / 最大化的 area */
                    hidden: z.array(z.string()),
                    hiddenViews: z.array(z.string()),
                    maximized: z.string().nullable(),
                  }),
                }),
              }),
              set: RpcSchema.unary({
                desc: `改布局（只改指定项，其余保持；track 尺寸传 px 数字，如 --cols 240,*,320）`,
                input: {
                  page: z.string().cliArg({ desc: "page id" }),
                  cols: z.string().optional().cliOption({ desc: "列尺寸，逗号分隔：数字=px，* = fr(1)，如 240,*,320" }),
                  rows: z.string().optional().cliOption({ desc: "行尺寸，同 cols" }),
                  hide: z.string().optional().cliOption({ desc: "要收起的 area，逗号分隔" }),
                  show: z.string().optional().cliOption({ desc: "要展开的 area，逗号分隔" }),
                  maximize: z.string().optional().cliOption({ desc: "最大化的 area id（空字符串=取消）" }),
                },
                output: z.object({ status: z.string() }),
              }),
              reset: RpcSchema.unary({
                desc: `回到开发者默认布局（尺寸 + 开合 + 最大化 + view 隐藏）`,
                input: { page: z.string().cliArg({ desc: "page id" }) },
                output: z.object({ status: z.string() }),
              }),
            },
          }),

          /**
           * view 的**内部**展开/折叠（折叠框）。
           * ⚠️ 与 `viewarea.set`（view 所在面板的开合）是两件事，别混：
           *    - expand 改的是 view 内部的折叠框（模板树 / 变量定义…）
           *    - viewarea 改的是承载 view 的面板几何（实验场面板整体开合）
           */
          view: RpcSchema.group({
            desc: `视图`,
            children: {
              expand: RpcSchema.unary({
                desc: `展开/折叠 view 内部的折叠框`,
                input: {
                  key: z.string().cliArg({ desc: "折叠框名（左栏 tree/trace/vars/vals；右栏 sysctx/reqbody/ctxpreview）" }),
                  open: z.string().cliArg({ desc: "open 或 closed" }),
                },
                output: z.object({ status: z.string() }),
              }),
              /**
               * view 级**隐藏/显示**（把某个 view 实例从 area 里拿掉 / 放回）。
               * 与 expand / viewarea.set 是三件事，别混：
               *   expand    view 内部的折叠框（模板树 / 变量定义…）
               *   viewarea  承载 view 的 area 整体开合
               *   set       单个 view 实例在 area 里的去留（实例状态保留）
               */
              set: RpcSchema.unary({
                desc: `隐藏/显示 view（view 级别，保留实例状态）`,
                input: {
                  view: z.string().cliArg({ desc: "view id（如 chat.local / task.detail / lab.editor，见 ui view list）" }),
                  open: z.string().cliArg({ desc: "open 或 closed" }),
                  page: z.string().optional().cliOption({ desc: "page id（缺省 task-run）" }),
                  ctx: z.string().optional().cliOption({ desc: "上下文键（context 型 view 必填，如任务 URI）" }),
                },
                output: z.object({ status: z.string() }),
              }),
            },
          }),

          /**
           * viewarea（承载 view 的面板）的开合。
           * 有几何语义、无身份语义：不区分 devtools 与普通面板，只是位置不同。
           */
          viewarea: RpcSchema.group({
            desc: `视图区域（面板）`,
            children: {
              set: RpcSchema.unary({
                desc: `开合 viewarea`,
                input: {
                  area: z.string().cliArg({ desc: "area id（如 left/center/right/bottom）" }),
                  open: z.string().cliArg({ desc: "open 或 closed" }),
                  page: z.string().optional().cliOption({ desc: "page id（缺省 task-run；同一 area 名在不同 page 上是不同的东西）" }),
                },
                output: z.object({ status: z.string() }),
              }),
            },
          }),

          /**
           * 任务执行页的 tab（打开的任务）。等同浏览器/编辑器开 tab：
           * 打开 = 我现在要做它；关闭 = 暂时不理会（**与任务状态无关**）。
           */
          tab: RpcSchema.group({
            desc: `任务 tab`,
            children: {
              open: RpcSchema.unary({
                desc: `打开（或聚焦）页面 tab`,
                input: {
                  uri: z.string().cliArg({
                    desc: "任务 URI，或 <pageId>:<任务 URI>（如 lab:projects/1/tasks/1 打开提示词子页面）",
                  }),
                },
                output: StatusDataUri,
              }),
              close: RpcSchema.unary({
                desc: `关闭页面 tab（关父连带关子；不改任务状态）`,
                input: { uri: z.string().cliArg({ desc: "tab key，如 task-run:projects/1/tasks/1" }) },
                output: StatusDataUri,
              }),
              active: RpcSchema.unary({
                desc: `切换到已打开的 tab`,
                input: { uri: z.string().cliArg({ desc: "tab key，如 task-run:projects/1/tasks/1" }) },
                output: StatusDataUri,
              }),
              list: RpcSchema.unary({
                desc: `已打开的任务 tab`,
                input: {},
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    opened: z.array(z.string()),
                    active: z.string(),
                  }),
                }),
              }),
            },
          }),

          /** 页面级服务 */
          page: RpcSchema.group({
            desc: `页面`,
            children: {
              info: RpcSchema.unary({
                desc: `获取页面信息`,
                input: {},
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    title: z.string(),
                    url: z.string(),
                    ready: z.boolean(),
                  }),
                }),
              }),

              /** 导航到指定页面（通过回调触发 React state 变更） */
              navigate: RpcSchema.unary({
                desc: `导航到页面`,
                input: { page: z.string().cliArg({ desc: "目标页面名称" }) },
                output: z.object({ status: z.string() }),
              }),

              /** 聚焦指定任务 */
              focus: RpcSchema.unary({
                desc: `聚焦任务`,
                input: { uri: z.string().cliArg({ desc: "任务 URI" }) },
                output: z.object({ status: z.string() }),
              }),

              /** 显示 Toast 通知 */
              toast: RpcSchema.unary({
                desc: `显示 Toast 通知`,
                input: { message: z.string().cliArg({ desc: "消息内容" }), level: z.string().optional().cliOption({ desc: "级别" }) },
                output: z.object({ status: z.string() }),
              }),
            },
          }),

          /** 任务树数据（结构化 JSON，供 CLI 和 UI 共用） */
          tree: RpcSchema.unary({
            desc: `加载任务树（结构化 JSON）`,
            input: {
              all: z.boolean().optional().describe('显示全部任务'),
            },
            output: z.object({
              status: z.string(),
              data: z.array(TaskNodeSchema),
            }),
          }),

          /** Renderer UI 状态（进程信息反向调 diy.getAppStatus） */
          status: RpcSchema.unary({
            desc: `Renderer 进程状态`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                pid: z.number(),
                uptime: z.number(),
                memory: z.number(),
              }),
            }),
          }),

          /** UI 侧项目操作（反向调 diy.project.* + 刷新树 + toast） */
          project: RpcSchema.group({
            desc: `项目`,
            children: {
              create: RpcSchema.unary({
                desc: `创建项目（UI 入口，反向调 main + 刷新任务树 + toast）`,
                input: {
                  path: z.string().min(1, "path 不能为空").cliArg({ desc: "项目路径" }),
                  label: z.string().optional().cliOption({ short: "l", desc: "显示名称" }),
                  desc: z.string().optional().cliOption({ desc: "描述" }),
                },
                output: StatusDataId,
              }),
              remove: RpcSchema.unary({
                desc: `删除项目（UI 入口；连带其下全部任务，不可恢复 —— 回收站见 ##138）`,
                input: {
                  id: z.string().cliArg({ desc: "project id" }),
                },
                output: StatusDataId,
              }),
            },
          }),

          /** UI 侧任务操作（反向调 diy.task.* + 刷新树 + toast） */
          task: RpcSchema.group({
            desc: `任务`,
            children: {
              create: RpcSchema.unary({
                desc: `创建任务（UI 入口，反向调 main + 刷新任务树 + toast）`,
                input: {
                  title: z.string().min(1, "标题不能为空").max(200).cliArg({ desc: "任务标题" }),
                  project: z.string().cliArg({ desc: "所属 project id" }),
                  parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
                },
                output: StatusDataUri,
              }),
              update: RpcSchema.unary({
                desc: `编辑任务（UI 入口，反向调 main + 刷新任务树 + toast）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                  title: z.string().optional().cliOption({ desc: "新标题" }),
                  body: z.string().optional().cliOption({ desc: "新内容" }),
                  change_type: z.string().optional().cliOption({ desc: "变更性质（空字符串=清除）" }),
                  module: z.string().optional().cliOption({ desc: "模块（空字符串=清除）" }),
                  priority: z.string().optional().cliOption({ desc: "优先级（空字符串=清除）" }),
                },
                output: StatusDataUri,
              }),
              setState: RpcSchema.unary({
                desc: `修改任务状态（UI 入口，反向调 main + 刷新任务树 + toast）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                  state: TaskStateSchema.cliArg({ desc: "新状态" }),
                },
                output: StatusDataUri,
              }),
              delete: RpcSchema.unary({
                desc: `删除任务（UI 入口；仅删本条，子任务失父升为一级任务，不可恢复 —— 回收站见 ##138）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: StatusDataUri,
              }),
            },
          }),

          /** UI 可见性诊断 — 遍历渲染器 DOM 生成无障碍树（agent 了解 UI 全貌的入口） */
          inspect: RpcSchema.unary({
            desc: `UI 诊断：生成当前页面的无障碍树（可见元素 + 角色 + 文本 + 层级）`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                tree: z.any(),
                stats: z.object({
                  totalNodes: z.number(),
                  visibleNodes: z.number(),
                }),
              }),
            }),
          }),

          /**
           * UI 状态单读（unary）—— 与 ui.watch.uiState 同一形状。
           * 用于「先读现状（拿 rev/uiRev/dataRev）→ 操作 → 再读/比对」的一次性调用；
           * 事件驱动等待用 ui.watch.uiState 流。
           */
          state: RpcSchema.unary({
            desc: `UI 状态快照（单读；含 rev/uiRev/dataRev 版本号）`,
            input: {},
            output: z.object({ status: z.string(), data: UiSnapshotData }),
          }),

          /**
           * UI 状态变化流（业务语义快照）—— renderer 侧事件源，createEffect 后推送。
           *
           * 为什么放 diy.ui.*：状态活在 renderer，事件源也在 renderer（createEffect 读 store），
           * 经 rpc-port 的 RendererForwarder 转发给 CLI/测试订阅；与 diy.watch.fileChange（main 侧）
           * 对称，只是事件源换到渲染进程的"渲染提交后"边界。
           *
           * 语义：**订阅即刻 yield 当前快照**（防丢唤醒），此后每次渲染提交（DOM 已更新）再 yield 全量快照。
           * 消费者不用轮询、不猜时机：`for await (snap) { if (ok(snap)) break }`。
           */
          watch: RpcSchema.group({
            desc: `UI 状态变化流（业务语义，渲染提交后快照）`,
            children: {
              uiState: RpcSchema.serverStream({
                desc: `UI 快照流 — 订阅即得当前态，之后每次 UI 变更（渲染提交后）推送全量快照`,
                input: {},
                output: z.object({ status: z.string(), data: UiSnapshotData }),
              }),
            },
          }),
        },
      }),
    },
  }),
});
