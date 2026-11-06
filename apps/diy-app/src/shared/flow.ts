/**
 * shared/flow.ts — flow 引擎 schema 集合
 *
 * 2026-11-06 从 `main/services/api-def.ts` 提出来。
 * **为什么必须提**：这组常量互相依赖且**顺序敏感**（Node → Anchor → Renderer → Edge → Post → ...），
 * 留在 api-def 里各复制一份则会漂移；复制时顺序错了就 used before declaration。
 */
import { z } from "zod";
import { RENDERERS } from "@diy-agent/flow";

export const FlowNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  actor: z.string(),
  hint: z.string(),
});

export const FlowRendererSchema = z.enum(RENDERERS);

export const FlowEdgeSchema = z.object({
  to: z.string(),
  toName: z.string(),
  kind: z.enum(["next", "bounce"]),
  when: z.string().nullable(),
});

export const FlowArtSchema = z.object({
  raw: z.string().describe("该节点产物的形状说明（raw 长什么样；行业自己知道）"),
  renderer: FlowRendererSchema,
  plugin: z.string().nullable().optional().describe("宿主 render 插件名（`diy flow view` 用的就是它）；空 = 直吃 raw（只在 raw 本身已是该 renderer 的 data 时才合法）"),
  note: z.string().optional(),
});

export const FlowPayloadViewSchema = z.object({
  renderer: FlowRendererSchema,
  payload: z.any().describe("给该渲染器的数据（形状由 renderer 约定；宿主原样透传 —— 收窄归 UI）"),
  note: z.string().optional(),
});

export const FlowVisitSchema = z.object({
  node: z.string(),
  seq: z.number(),
  kind: z.enum(["next", "bounce"]),
  at: z.string(),
  ref: z.record(z.string(), z.string()).optional(),
});

export const FlowViewSchema = z.object({
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

export const FlowArtifactViewSchema = z.object({
  uri: z.string(),
  node: z.string(),
  nodeName: z.string(),
  seq: z.number().describe("目标驻留序号（1-based = 折线上该节点第几次驻留）"),
  art: FlowArtSchema.nullable().describe("该节点声明的展示链（没声明 ⇒ null）"),
  plugin: z.string().nullable().describe("实际用到的 render 插件名（null = 直吃 raw / 没声明 art）"),
  view: FlowPayloadViewSchema.nullable().describe("翻译结果；该驻留没有产物 ⇒ null"),
  bag: z.string().describe("产物袋文件（不存在也是正常态：产物不是领域态）"),
});

export const FlowAnchorSchema = z.object({
  from: z.string().describe("打回前所在节点"),
  to: z.string().describe("打回落点节点"),
  seq: z.number().describe("落点那次驻留的序号（Visit.seq）—— 同一节点二次打回靠它区分，不串台"),
});

export const FlowPostSchema = z.object({
  id: z.string(),
  at: z.string(),
  author: z.string().describe("谁说的：cli（人敲） / agent 标识（驱动环起的轮次） / human"),
  type: z.enum(["note", "resolved", "escalate"]).describe("note=发言（含自动打回的意见正文）/ resolved=宣布线程已解决 / escalate=升级人裁决"),
  anchor: FlowAnchorSchema,
  text: z.string(),
});

export const FlowThreadSchema = z.object({
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

export const FlowThreadsSchema = z.object({
  uri: z.string(),
  threads: z.array(FlowThreadSchema),
  skipped: z.number().describe("讨论流里跳过（读不出 / 形状不符）的行数 —— 旁注可坏，坏了只报数"),
  error: z.string().nullable().describe("讨论流的错误位（null = 没出错）：读不出 / 有坏行时也不外抛"),
  file: z.string().describe("讨论流文件（不存在也是正常态：还没人发过言）"),
});

export const kvList = () => z.union([z.string(), z.array(z.string())]);
