/**
 * api-domains/room/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { RoomEventSchema, RoomMemberSchema, RoomSchema } from "../../../../shared/room";

export const roomRoutes = RpcSchema.group({desc: `多人房间（人 + 多 agent 同室；room 只做投递 + 汇总，各成员有自己的会话）。**宿主定案（##166 §28.7 G）：room = 任务对话页的状态，id 就是 taskUri** —— 每个任务恒是一个 room（不加人 = 成员表只有主人格）`,
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
        },});

export const roomService = defineService({ name: "diy.room", api: roomRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: roomApi, handlers: { room: … } })`
 * 与上面的 `roomService` 完全等价（后者 = prefix "diy" + 模块层 "room"）。
 */
export const roomApi = RpcSchema.group({ children: { room: roomRoutes } });
