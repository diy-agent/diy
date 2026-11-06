/**
 * api-domains/agent/local.ts —— 从 api-def.ts 的 `agent.local` 拆出。
 */
import { z } from "zod";
import { RpcSchema } from "@diy-agent/rpc";
import { ModelCostSchema } from "../../../../shared/usage";
import { SteerItemSchema } from "../../../../shared/steer-item";

export const localRoutes = RpcSchema.group({desc: `本地自定义 agent（ai-sdk，独立于 ACP 通道）`,
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
                /**
                 * 手动压缩条的轴（##519，只读）：**一步一行**，每行带这一步实测新增的 token。
                 *
                 * 为什么要它：人能一眼看到「保留最近 N 步 ≈ 多少 token」，从而把压缩位置拖到
                 * 他要的地方（默认 = 窗口 × 0.16 落在第几步）。数字来自 `usage.jsonl` 的实测总量差分
                 * —— 不是估算（每步 370~114k 都能差出量级）。
                 */
                ledger: RpcSchema.unary({
                  desc: `手动压缩条的轴（只读）：每步实测新增 token + 当前边界 + 16% 默认落点`,
                  input: { taskUri: z.string().cliArg({ desc: "任务 URI" }) },
                  output: z.any(),
                }),
                /**
                 * 把压缩位置拖到「保留最近 N 步」（##519）。
                 *
                 * 换算在 main 侧做（`keptStepsView` 的实测增量 → token 预算），落盘仍走既有边界机制：
                 * 切点照旧吸附到 user + 轮首（`resolveOpsReplay` 的 seek 依赖轮首锚点），
                 * 所以**不影响 UI 重放**，只改「这一轮发多少历史」。
                 */
                setKept: RpcSchema.unary({
                  desc: `把压缩位置拖到「保留最近 N 步」（体内换算成 token 预算；切点仍落 user+轮首）`,
                  input: {
                    taskUri: z.string().cliArg({ desc: "任务 URI" }),
                    keepSteps: z.number().cliOption({ desc: "保留最近多少步（0 = 全清；缺省按实测中位数换算）" }),
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
            },});
