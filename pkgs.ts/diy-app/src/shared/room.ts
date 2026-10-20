// src/shared/room.ts
// 🎯 多人房间（room）契约 —— main（投递器）/ RPC / UI / CLI 四方共用。
//
// 设计真源：##166 §28（room 核心设计骨架 + §28.5 定案）；开发日志见 ##377。
// 三条口径照抄设计、不在本文件重新论证：
//   1. **room ≠ session**：room 只是「投递 + 汇总层」，不承载任何成员的上下文（§28.5 A 连带结论 1）；
//   2. **成员各自独立 session**（§28.5 A）：本切片按 §28.6 待决 72 的 (a) ——
//      agent 成员 backend 绑「一个 task 的本地会话」（复用现有一切：CLI / RPC / 装配 / UI）；
//   3. **必须 @**（§28.5 B）：`@X` 显式覆盖，否则投给房间的当前接受者 `focus`；
//      两者都没有 ⇒ **只落盘不投递**（=「只有自己能看到」），UI 必须标「未投递」。
//
// 纯 zod + 纯函数，零 node 依赖（UI 与 main 共用同一份判据，避免"两处各写一套 if"）。

import { z } from "zod";

/**
 * 房间 id —— **宿主定案（##166 §28.7 G）：就是 taskUri**（`projects/4/tasks/377`）。
 *
 * room 从「独立容器 + 独立页」降为「**任务对话页的一个状态**」：加人 = 成员表多一行，
 * 单人任务 = 成员表只有主人格的 room（**向后兼容**，见 §28.7 G 推论 4）。
 * 故 id 直接复用 taskUri（含 `/`）—— 它是**路径安全**的（tasks 目录下的一层），
 * 校验只排除 `..` 与首尾斜杠（防越出 `rooms/` 根）。
 */
/**
 * room id 允许的字符。
 *
 * **含 `:`** —— ##166 §31 待拍 82/85 拍板侧边栏 room 的 id 是
 * `agent:room:ui/sidebar-<实例>`（id 直接当落盘目录名，实测 macOS 可建含冒号目录）。
 */
export const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:./-]*$/;

/** 房间 id 是否安全（同时是**目录名**判据：不许 `..` / 不许结尾 `/`） */
export function isValidRoomId(id: string): boolean {
  if (!ROOM_ID_RE.test(id)) return false;
  if (id.includes("..")) return false;
  if (id.endsWith("/")) return false;
  return true;
}

/**
 * **主人格**的成员 id（成员表第一行，##166 §28.7 G 推论 3）。
 *
 * 它是宿主任务**自己的** agent：`backend = 本 task`、`persona = 任务的 persona`。
 * 不搞「主人特例」—— 它就是一条普通成员记录，只是 `main: true`：
 *   · 投递给它 = 在本任务会话里起一轮（与旧版"直接在任务对话里说话"**同一条通道**）；
 *   · 它的正文**不加房间包装**（见 `deliveryText.plain`）—— 对宿主而言那句话就是本人说的；
 *   · UI 渲染时它的事件**不重复画**（本会话的块流里已经有那一轮）。
 */
/**
 * **侧边栏 room**（##166 §30：全局悬浮助手 room）的 id 前缀 —— §31 待拍 82/85 已拍。
 *
 * 与任务 room 的分工：任务 room 的 id = taskUri（§28.7 G）；侧边栏 room **不属任何任务**，
 * 所以 id 自成一族（`agent:room:` 前缀 = "room 自己的命名空间"）。
 */
export const SIDEBAR_ROOM_PREFIX = "agent:room:ui/sidebar-";

/** 稳定短哈希（djb2 → base36）。用途：把 diyHome 压成短且**确定**的实例标识（不是新身份体系，只是编码） */
export function shortHash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36).padStart(6, "0").slice(0, 6);
}

/**
 * 侧边栏 room 的 id —— `<实例>` 由**现有实例身份**派生（##30 owner 口径：用 `getAppInfo` 那套，
 * 不新造身份体系）：`env`（人一眼看出是哪个实例）+ `diyHome` 的短哈希
 * （同一台机器上多个 worktree 各有自己的数据根 ⇒ 各自的侧边栏 room 互不串）。
 *
 * ⚠️ 用 **diyHome** 而不是 **port** 作哈希源：端口每次重启都会变（`resolvePort` 非生产随机），
 * 拿它做 id 会让侧边栏 room **每次重启换一个**（成员表丢）。diyHome 是稳定的那个。
 */
export function sidebarRoomId(env: string, diyHome: string): string {
    const e = env === "production" ? "prod" : env === "development" ? "dev" : env || "unknown";
    return `${SIDEBAR_ROOM_PREFIX}${e}-${shortHash(diyHome)}`;
}

/** 这个 id 是不是侧边栏 room 的（决定"主人格 backend 从哪来" —— 它没有 task 可绑） */
export function isSidebarRoomId(id: string): boolean {
    return id.startsWith(SIDEBAR_ROOM_PREFIX);
}

export const MAIN_MEMBER_ID = "agent:main";

/** 人的成员 id（发言人恒是页面操作者本人；沿用最小切片的名字） */
export const HUMAN_MEMBER_ID = "human:chen56";

export const RoomMemberKindSchema = z.enum(["human", "agent"]);
export type RoomMemberKind = z.infer<typeof RoomMemberKindSchema>;

/**
 * 成员 backend —— 该成员**自己的会话**在哪（§28.5 A 连带结论 2：每个成员必须有 backend）。
 *
 * 遵 `rule.discriminated-union`：判别键 `type` 同级 = 公共字段，分支私有数据进 `data`。
 * 目前只有一个分支（绑 task 的本地会话）—— 留着判别联合是给 §28.6 待决 72 的 (b)
 * （room 内独立 session）留口：加分支即可，形状不变。
 */
export const RoomBackendSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task"),
    data: z.object({
      taskUri: z.string().describe("该成员的会话所在任务 URI（复用现有一切：CLI/RPC/装配/UI）"),
    }),
  }),
]);
export type RoomBackend = z.infer<typeof RoomBackendSchema>;

export const RoomMemberSchema = z.object({
  /** 全局 id 短式（接 §25 `<ns>:<type>:<path>`）：`human:chen56` / `agent:dev` */
  id: z.string(),
  /** 显示名（气泡署名 / `@` 寻址用） */
  name: z.string(),
  kind: RoomMemberKindSchema,
  /** 人的会话不在 task 里（§28.6 待决 76 未定案）—— 最小切片给 null */
  backend: RoomBackendSchema.nullable(),
  /** **主人格**（= 宿主任务自己的 agent；成员表第一行，##166 §28.7 G 推论 3） */
  main: z.boolean().optional(),
  /**
   * 人物 id（`core:persona:<id>`，§25 全式）—— 决定它以**什么身份 + 什么行为指令**说话。
   * 与 backend（在哪说、有什么上下文）解耦：同一人物可进多个 room（§28.7 B）。
   */
  persona: z.string().optional(),
  role: z.string().optional(),
  color: z.string().optional(),
  /** 头像（emoji）。留空 = 按成员在房间里的位置自动分配（`memberAvatar`） */
  avatar: z.string().optional(),
});
export type RoomMember = z.infer<typeof RoomMemberSchema>;

/**
 * channel —— **room（空间）+ channel（流）两层**（##166 §28.J 三层模型 / §28.K ①）。
 *
 * Discord 模型：**成员表属空间、流属频道** —— 「我加入了这个服务器」与「我在听哪个频道」
 * 是两件事。本切片 channel **只做占位符**（##166 §28.K 定案）：
 *
 *   · `Room.channels` **恒有一条 `default`**（名字「默认」）；
 *   · 事件带 `channel`（**落盘** —— §28.K 待拍 17：将来多流才能按 channel 过滤历史）；
 *   · **不做**：多流 / channel 订阅 / channel 级可见性（§28.J 三条边界，守死）。
 *
 * 判据 = **行为与今天逐字一致**：只有一条 channel ⇒ 零分支（不写 `if (channel === default)`）。
 * room 内引用用**短式** `default`；全式 id `agent:channel:tasks/377`（§25）留给多流时用。
 */
export const DEFAULT_CHANNEL_ID = "default";
export const DEFAULT_CHANNEL_NAME = "默认";

export const RoomChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type RoomChannel = z.infer<typeof RoomChannelSchema>;

/** 恒有的那一条 channel（新房间、以及老房间读出来补齐，都用它） */
export function defaultChannels(): RoomChannel[] {
  return [{ id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_NAME }];
}

export const RoomSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  /**
   * 当前接受者（成员 id）。**一等字段、必须落盘、全成员可见**（§28.5 B 推论 2）——
   * 否则人 / agent 都不知道自己在跟谁说话。null = 未设（此时无 `@` 的发言一律未投递）。
   */
  focus: z.string().nullable(),
  members: z.array(RoomMemberSchema),
  /**
   * channel 表 —— **恒有 `default`**（本切片只占位，见 `DEFAULT_CHANNEL_ID`）。
   *
   * `.default(...)` 是**读侧兼容**：占位符引入之前建的房间（room.yaml 里没有这个键）
   * 照样读得出来并补上 `default` —— 不迁移存量、不产生"老房间读不出"的假故障。
   */
  channels: z.array(RoomChannelSchema).default(() => defaultChannels()),
  /**
   * **成员水位**（##166 §44.6 四.1）：`成员 id → 该成员已经看到过的最后一条事件 id`。
   *
   * 用途只有一个 —— 投递时算「自上次以来房间里**别人**说了什么」，把那段上下文附进正文。
   * 为什么记 **id** 而不记时间戳：同一毫秒可能落两条事件（`nextEventId` 的 ts 是毫秒）
   * ⇒ 时间戳比较会在"同毫秒"上丢边界。而**也不能拿 id 比大小**（序号跨进程重来，踩坑 3）——
   * 读侧一律按 `events.jsonl` 的**物理顺序**定位（append-only ⇒ 顺序就是因果顺序）。
   *
   * `.default({})` 兜存量：老房间没有这个键 ⇒ 第一次投递时按"从头看"处理（最多吐上限条）。
   */
  lastSeen: z.record(z.string(), z.string()).default({}),
  created: z.string(),
  updated: z.string(),
});
export type Room = z.infer<typeof RoomSchema>;

/**
 * 一条发言的投递依据：`explicit` = 显式 `@X`；`all` = 显式 `@all`（群发）；
 * `focus` = 隐式当前接受者；`none` = 都没（只落盘）。
 */
/**
 * 投递路由（##166 §35.2 + §38.2）：
 *   · `explicit` 显式 `@` 了成员 · `all` `@all` 群发 · `focus` 无 `@` 但有当前接受者；
 *   · **`note`** = 「这是一条**笔记**」（无 `@` 无 focus，或只 `@` 了自己）——
 *     **零投递、正常落盘、不报错**（用户口径：「发送给自己的消息不要报错，就当成普通消息」）；
 *   · `none` = 旧数据里的历史值（`note` 的前身，**保留以便读旧事件流**）。
 *
 * ⚠️ 与 `unknown-recipient`（**打错名字 = 真故障**，要报）的区分是本节的全部要点：
 * 把「本来就没打算投」做成报错，**就是让人不敢写笔记**。
 */
export const RoomRoutingSchema = z.enum(["explicit", "all", "focus", "note", "none"]);
export type RoomRouting = z.infer<typeof RoomRoutingSchema>;

/**
 * **单个收件人**的投递状态（一条发言可有 N 个收件人 ⇒ N 个状态，各自独立）。
 *
 * `queued` 是「消息对一个人是阻塞的」的直接体现：同一成员的投递**串行**，
 * 前一条没跑完时后一条停在 `queued`（**不丢、不合并**）；不同成员之间并行。
 */
export const DeliveryStatusSchema = z.enum(["queued", "running", "ok", "failed", "skipped"]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const DeliveryStateSchema = z.object({
  memberId: z.string(),
  status: DeliveryStatusSchema,
  /** 该成员这一轮跑在哪个会话（审计 / 判据 3 的证据链：去那个 task 的 ops 流里找 turnId） */
  taskUri: z.string().optional(),
  turnId: z.string().optional(),
  /** 这一轮的回复是哪条事件（`ok` 时才有；失败/排队时缺省） */
  replyId: z.string().optional(),
  /** 失败/跳过原因（人话） */
  error: z.string().optional(),
  /**
   * **补充说明**（人话，不是错误）—— 只有 `status:"ok"` 时偶尔有值。
   *
   * 第一种用途（##377 第 27 刀）：会话正有轮次在跑 ⇒ 这条不"开一轮"，而是
   * **插进正在跑的那一轮**（下一步生效）。消息确实送达了（`ok`），但拿不到一条属于
   * 自己的回复 —— 不写这句，人看到"已投递"却没有回复会以为丢了。
   *
   * ⚠️ 与 `error` 分开是因为语义相反：`error` = 没送到 / 送失败；`note` = 送到了，但方式不同。
   */
  note: z.string().optional(),
  ts: z.string(),
});
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

export const DeliveryOriginSchema = z.object({
    /** 房间 id（宿主任务的 room = taskUri；侧边栏 room = `agent:room:ui/sidebar-<实例>`） */
    roomId: z.string(),
    /** 那条 `say` 事件的 id —— 拿着它回房间就能定位原话（事件流是 append-only） */
    sayId: z.string(),
});
export type DeliveryOrigin = z.infer<typeof DeliveryOriginSchema>;

/** 事件：`say` = 人（或未来某个成员）发的一句话；`reply` = 被投递 agent 跑完一轮的回复 */
export const RoomEventSchema = z.object({
  id: z.string(),
  ts: z.string().describe("ISO 时刻"),
  /**
   * 这条事件属于哪条 channel（**落盘**，##166 §28.K 待拍 17）。
   *
   * 本切片恒为 `default`（只有一条流 ⇒ 零分支）；`.default(...)` 只兜**存量事件**
   * （占位符之前写的事件行没有这个键）—— 新事件一律显式写盘。
   */
  channel: z.string().default(DEFAULT_CHANNEL_ID),
  kind: z.enum(["say", "reply"]),
  /** 发言者成员 id；解析不出成员时是原始名字（外部主体） */
  author: z.string(),
  /** 收件人成员 id（解析后）。空 = 未投递 */
  to: z.array(z.string()),
  /** 投递依据（**只有 `say` 事件有意义**；`reply` 是投递结果本身，不带依据） */
  routing: RoomRoutingSchema.optional(),
  /** **原话**（含 `@X` 前缀）—— 投递时另剥（正文要干净） */
  text: z.string(),
  /**
   * 是否投递成功（任一个收件人 `ok`）。
   *
   * ⚠️ 它是**读侧投影**：落盘时恒为 false（那会儿还没投），`core/room.readRoomView`
   *    按投递状态 fold 后填**真值**。别把盘上那份当结论。
   */
  delivered: z.boolean(),
  /** 投递失败原因（人话）；delivered=false 且有它 = 有话说不出 */
  error: z.string().optional(),
  /** 该回复来自哪个 task 会话（`reply` 事件带；审计用 —— 判据 3 的证据链） */
  sourceTask: z.string().optional(),
  /**
   * **这一轮的引用**（##166 §28.7 A1）：`reply` 事件带，指向成员会话里的那一轮。
   *
   * room **不新造进度数据源** —— 进度就是「成员会话的 `ops.jsonl` 按 `turnId` 切一刀」，
   * 与任务对话看到的是同一条流、同一套渲染（§28.7 A：room 只需「对成员会话的引用 + 并列渲染」）。
   * `memberUri` = 房间成员 id（`agent:dev`）；会话本体仍是 `sourceTask`（两者都带，读侧不必再查成员表）。
   */
  ref: z
    .object({
      memberUri: z.string().describe("成员 id（房间内，如 agent:dev）"),
      turnId: z.string().describe("该成员会话里这一轮的 turnId（ops 流按它切片）"),
    })
    .optional(),
  /** 各收件人的投递状态（读侧投影 —— 落盘在 `deliveries.jsonl`，读时附上来） */
  deliveries: z.array(DeliveryStateSchema).optional(),
  /**
   * **这条事件从别的房间投过来的**（##377 第 24 刀 · 双向可见）。
   *
   * 只有「投递写回接收方自己房间」的那两条事件（`say` + `reply`）带它 ——
   * 目的是让接收方房间的读侧能答两个问题：这条是谁投的、源房间那条原话在哪。
   * 不带 = 本房间自己产生的（绝大多数事件）。
   */
  origin: DeliveryOriginSchema.optional(),
});
export type RoomEvent = z.infer<typeof RoomEventSchema>;

// ─── 纯函数（main 与 UI 共用同一份判据）─────────────────────────────

/**
 * 解析正文**开头**的 `@名字`（原型见 ##166 §27.3 可挑资产 / 搁置分支 `core/room.ts::parseAddress`）。
 *
 * 只认开头（不是"正文里出现过 @"）—— 否则「我觉得 @reviewer 说得对」会被误判成寻址。
 * 名字 = **一整段非空白、非分隔标点**（覆盖 `dev` / `all` / 中文人物名 `开发`）；
 * 全式 id（`agent:dev` / `human:chen56`）请直接写名字那半（`@dev` / `@chen56`）—— 冒号留给正文标点。
 *
 * **可连写多个**（本切片按用户口径扩的）：`@dev @review 一起看下` ⇒ 两个收件人、正文「一起看下」。
 * 分隔只认空白 / 逗号 / 顿号（不认冒号 —— `@dev: 你好` 里的冒号是正文标点，历史上一直如此）。
 */
/**
 * 一个**已完整**的 `@名字` 地址（名字字符集：除空白与分隔标点（含 `:`）以外的一整段 ——
 * 于是中文人物名（`@开发`）也能寻址，而 `@dev: 你好` 里的冒号仍是正文标点，历史行为不变）。
 *
 * **补全与投递共用这一份**：`addressQueryAt`（输入框弹面板）必须与 `parseAddress`（服务端真投递）
 * 是同一条判据 —— 否则「弹了但没投递」比没有补全更坏（##166 §37.2 B）。
 */
const ADDRESS_RE = /^\s*@([^\s@,，、:]+)\s*[,，、]?\s*/;

export function parseAddress(text: string): { text: string; tos: string[] } {
    const tos: string[] = [];
    let rest = text;
    for (;;) {
        const m = ADDRESS_RE.exec(rest);
        if (!m) break;
        tos.push(m[1]!);
        rest = rest.slice(m[0].length);
    }
    if (tos.length === 0) return { text, tos };
    // 只喊人、没正文（`@dev`）⇒ 保留原文，不产生空正文
    return rest.trim() ? { text: rest, tos } : { text, tos };
}

/**
 * 「光标此刻是否处在**会生效的 `@` 寻址位**」—— 是则给出正在输入的名字片段与它的起点。
 *
 * 判据 = **把 `parseAddress` 的循环照跑一遍**，剥掉前面所有已完整的地址，再看剩下的部分
 * 是不是「正好一个 `@` + 尚未输入完的名字」：
 *
 * ```
 * "@dev @rev"   → 剥掉 @dev，剩 "@rev"  ⇒ 命中（query="rev"，可继续连写第二个收件人）
 * "请 @dev 看"  → 开头不是 @ ⇒ 剩原文 ⇒ 不命中（**句中不弹** —— 服务端也不认，见 §37.2 B）
 * "##377"       → 不命中（那是任务引用，不是寻址）
 * ```
 *
 * ⚠️ 与 `parseAddress` **同一 regex**（`ADDRESS_RE`）：判据漂移 = 「弹了却不投递」，那是负价值。
 */
export function addressQueryAt(text: string): { query: string; from: number } | null {
    // 只看**最后一个** `@`：前面的全是已敲完的地址，当前正在输的那个必是最后一段。
    // （⚠️ 不能拿 ADDRESS_RE 去"剥到剩最后一个" —— 它会把**正在输的** `@dev` 也当成完整地址吃掉，
    //   于是 `@dev` 反而不弹，正是补全最该弹的时刻。）
    const at = text.lastIndexOf("@");
    if (at < 0) return null;
    const query = text.slice(at + 1);
    // ① 当前片段必须尚未完结：不含空白 / 分隔标点 / 另一个 `@`（含则光标已离开这个地址）
    if (/[\s@,，、:]/.test(query)) return null;
    // ② 它前面的部分必须是**合法的地址序列**（用 ADDRESS_RE 循环剥完，剩下的只能全是空白）
    let rest = text.slice(0, at);
    for (;;) {
        const m = ADDRESS_RE.exec(rest);
        if (!m) break;
        rest = rest.slice(m[0].length);
    }
    if (rest.trim()) return null;
    return { query, from: at };
}

/** `@all` / `@*` 记号（群发）——单收件人寻址与它互斥，但可**并列**（`@all @dev` 仍是全体） */
export function isAllAddress(nameOrId: string): boolean {
  return nameOrId === "all" || nameOrId === "*";
}

/**
 * 投递判据（§28.5 B 的 `resolveRecipients` + 一条本切片新增的 `@all`）：
 *
 * ```
 * evt.to?.length ? 展开(evt.to)      // ① 显式 @ 优先（可多个；`@all` = 房间里的所有 agent 成员）
 * : focus        ? [focus]           // ② 无 @ 时投给「当前接受者」
 * :                []               // ③ 都没有 → 只落盘、不投递
 * ```
 *
 * `@all` 为什么**只展开到 agent 成员**：投递 = 在对方会话里真起一轮，人不需要（他本人在场，
 * 发言他自己看得见）—— 把人算进收件人只会让"投递失败"看起来像出错。
 *
 * ⚠️ 除 `@all` 外**协议里没有隐式广播**：要多收件人必须显式列 ⇒ 成本从「默认 N 倍」变成「显式 N 倍」。
 */
export function resolveRecipients(
  to: readonly string[] | undefined,
  focus: string | null | undefined,
  members: readonly RoomMember[] = [],
  /**
   * 发言者本人（##166 §38.2）：`@` 自己 = **笔记**（不是投递）。
   * 不传 = 与旧行为逐字一致（不知道"谁在说"时无法识别"@ 自己"）。
   */
  self?: string | null,
): { recipients: string[]; routing: RoomRouting } {
  const explicit = (to ?? []).filter((t) => !!t);
  if (explicit.length > 0) {
    const hasAll = explicit.some(isAllAddress);
    // ⚠️ `@` 自己**不算收件人**：自己给自己投递没有意义（会在自己的会话里起一轮）
    const named = explicit.filter((t) => !isAllAddress(t) && t !== self);
    const agents = members.filter((m) => m.kind === "agent").map((m) => m.id);
    const recipients = [...new Set([...named, ...(hasAll ? agents : [])])];
    // 只剩自己 ⇒ 笔记（**不是** fallback 到 focus：用户显式 @ 了自己，就该照他说的做）
    if (recipients.length === 0) return { recipients: [], routing: "note" };
    return { recipients, routing: hasAll ? "all" : "explicit" };
  }
  if (focus) return { recipients: [focus], routing: "focus" };
  return { recipients: [], routing: "note" };
}

/**
 * 名字或 id → 成员：`@dev` / `dev` / `agent:dev` 都认；不认得就原样返回（外部主体 / 未来扩展）。
 *
 * 前导 `@` 一律剥掉：命令行的 `--member @review` 与正文里的寻址写法是**同一个直觉**
 * （实测踩到：不剥时 `@review` 会被当成一个陌生名字而报"房间里没有这个成员"）。
 */
/**
 * 「这条事件该由 **ops 流**显示，还是由 **room 事件流**显示」（##377 第 17 刀 / ##166 §44.2 B）。
 *
 * 任务页的时间线是**两个源拼起来的**：本任务 ops 流（主人格，逐字不变）+ room 事件流。
 * 主人格相关的东西**两边都有** —— room 投递给主人格 ⇒ 主人格会话里落一个 user 块；
 * 主人格的回复 ⇒ 就是它自己会话里那一轮 ⇒ 必须有**一条**判据定死"谁负责显示"，
 * 否则症状是"要么重复一条、要么少一条"（§44.2 B 押的正是这一点）。
 *
 * 判据的形状是「**ops 流里有没有这条**」，不是"说话人是谁"：
 *   · `say`（人的发言）：投给了主人格 ⇒ 主人格会话里有个 user 块 ⇒ ops 有；
 *     没投给主人格（`@dev`）⇒ 那句话不在**任何**本任务会话里 ⇒ room 事件流负责。
 *   · `reply`（成员的回复）：**回复者就是主人格** ⇒ 那一轮本来就在本任务 ops 流里 ⇒ ops 有；
 *     别人回复 ⇒ 只住在它自己的会话里 ⇒ room 事件流负责。
 *
 * ⚠️ 别按「事件 `to` 含主人格」一条打天下（§44.2 B 的行文）：`reply` 的 `to` 是**发起者**
 * （人成员），永远不含主人格 ⇒ 主人格的回复会被画第二遍。两种 kind 的判据**不同源**，
 * 这里合成一条函数正是为了让它只有一个落点（可单测、可复用）。
 *
 * 返回 true = **ops 流负责**（room 侧跳过，不重复渲染）。
 */
export function opsOwnsEvent(
    e: Pick<RoomEvent, "kind" | "to" | "ref">,
    mainMemberId: string = MAIN_MEMBER_ID,
): boolean {
    if (e.kind === "say") return e.to.includes(mainMemberId);
    if (e.kind === "reply") return e.ref?.memberUri === mainMemberId;
    return true; // 认不出的 kind 一律不画（白名单式：宁可少画，不可画错）
}

/**
 * 投递时落进成员会话的**署名**（##166 §40 B 的收窄 —— 第 17 刀）。
 *
 * §40 B 原文 =「值 = 发起投递的成员 id」。第 17 刀把任务页主输入框改走 room 之后，
 * 这条规则在**主人格**上会撞 §44.2 A「无 `@` = 投给主人格 = **与今天等价**」：
 * 主人格的会话就是**本任务自己的会话**，而今天那条 user 块**没有 author**
 * （右对齐、无署名 —— §40 C）。凭空带上 `human:chen56` ⇒ 气泡翻到左侧 + 加署名
 * ⇒ 判据 1 / 判据 7（逐字一致）当场破。
 *
 * 规则：**投给主人格 且 发起者是页面操作者本人** ⇒ 不署名（"我对我自己的 agent 说话"，
 * 与任务页今天的形状一致）。其它组合（agent 投给主人格 / 任何人投给别的成员）照旧署名。
 *
 * 溯源没丢：room 侧的 `say` 事件**恒有** `author`（那才是房间历史的溯源），
 * 这里去掉的只是 **ops 块 meta 里那份冗余副本**。
 */
export function opsAuthorFor(main: boolean, author: string): string | undefined {
    return main && author.startsWith("human:") ? undefined : author;
}

/**
 * 一条投递的**来源**（##377 第 23 刀）：这句话从哪个房间、哪一条 `say` 投过来的。
 *
 * 与 `author` 分工：`author` 说「**谁**说的」，`room` 说「**从哪**来的」。
 * 二者都落进收件方会话那条 user 块的 meta（`meta.author` / `meta.room`）。
 *
 * 为什么需要它（用户报「有 bug、不能真正使用」的直接后果之一）：
 * 今天投递进接收方会话是一条**普通 user 块** —— 它看起来「就是这个任务的人说的」，
 * 接收方**分不清**「本任务的人在跟我说话」与「别的房间投过来的一句」。
 * 有了来源，UI 才能标出来，未来「把这条写回接收方自己的 room」也有了键（双向可见的地基）。
 */


/** 一条发言的**随附事实**（`chat` 的第 7 参 —— 替代原来单个 `author`，再扩不必加第 8 个位次）。 */
export type TurnOrigin = {
    /** 谁说的（同 `opsAuthorFor` 的语义；缺省 = 本任务本人） */
    author?: string;
    /** 从哪来的（只有 room 投递带） */
    room?: DeliveryOrigin;
    /**
     * **不落盘**：本轮是 room 投递发起的（判据用）。
     *
     * 为什么不能只看 `room`（##377 第 25 刀实测抓出的回归）：投给**主人格**且发起者是页面
     * 操作者本人时，`opsOriginFor` 按 §44.2 A **整条不落**（不署名、也不带 `room`）
     * —— 那正是「无 @ 发送 = 与今天等价」的代价。于是 `room` 有值与否**表达不了**
     * 「这一轮是不是投递」，用它在轮首判「要不要注入房间上下文」⇒ 投给主人格时
     * 注入两遍（`deliveryText` 一遍 + 轮首注入一遍）。
     *
     * ⇒ 「落不落盘」与「是不是投递」是**两件事**，各用一个字段，互不牵连。
     */
    fromDelivery?: boolean;
    /**
     * **不落盘**：这一轮该看哪间房（`runtime.room` 的来源）。
     *
     * 为什么不能只看 `room`（##377 第 26 刀 review1 R1）：`room` 是**落盘**判据
     * （`meta.room`）—— 投给主人格 + 发起者是页面操作者本人时它整条不落（§44.2 A）。
     * 于是"从侧边栏 room 里 @ 某个任务的主人格"这一轮会**退回本任务自己的房间**，
     * 看不到来源房间里刚发生的事（第 25 刀时正文里还带着，第 26 刀搬走后就真空了 —— 回归）。
     *
     * ⇒ 「看哪间房」（`sourceRoomId`）与「落盘落什么」（`author` / `room`）是两件事。
     */
    sourceRoomId?: string;
    /**
     * **不落盘**：来源房间里那条 `say` 的 id —— `runtime.room.recent` 要**排除**它。
     *
     * 为什么也要单独带：`room.sayId` 随 `room` 一起在「投给主人格 + 发起者是人」时被掐掉
     * （§44.2 A），于是那一轮的 `recent` 里会出现**自己这条投递**（正文里已经有一份，
     * 等于同一句话出现两次；lab 实测抓出）。排除判据与落盘判据分开就对了。
     */
    sourceSayId?: string;
};

/**
 * 投递时要落进成员会话的**随附事实**（`author` 的整条兜底 —— 第 23 刀）。
 *
 * 口径的落点只有一个：`opsAuthorFor` 说「不署名」时，**整条都不落**（含 `room`）。
 *
 * 为什么连 `room` 也要一起掐掉：投给主人格 + 发起者是页面操作者本人 = 「我对我自己的
 * agent 说话」—— 那是任务页**自己的**会话，一旦落 `room`，UI 会给它画上「房间投递」标记
 * ⇒ §44.2 A「无 @ 发送 = 与今天等价」/ 第 16 刀判据 7「单人任务逐字不变」当场破。
 * 溯源没丢：room 侧的 `say` 事件恒在（那才是房间历史的溯源）。
 */
export function opsOriginFor(main: boolean, author: string, room: DeliveryOrigin): TurnOrigin {
    const a = opsAuthorFor(main, author);
    // `sourceRoomId` **恒带**（不落盘）：它是"这一轮该看哪间房"的唯一来源，
    // 与"落盘落什么"分开 —— 否则投给主人格时那一轮会退回本任务自己的房间（review1 R1）。
    const view = { sourceRoomId: room.roomId, sourceSayId: room.sayId };
    return a === undefined ? view : { author: a, room, ...view };
}

/**
 * **投递发起**的一轮要带的随附事实（`deliverOne` 的唯一入口，##377 第 25 刀）。
 *
 * 与 `opsOriginFor` 的分工：那个只管「落盘落什么」（可能返回 `undefined` = 整条不落），
 * 这个恒带 `fromDelivery: true` —— 轮首注入靠它判「正文已经带过房间上下文了，别再拼一遍」。
 *
 * ⚠️ 两件事必须分开看，否则必踩两个坑之一：只按 `room` 判 ⇒ 投给主人格时重复注入；
 * 只按 `fromDelivery` 判 ⇒ 非投递的自起轮（任务页点跑 / 定时任务）拿不到上下文。
 */
export function deliveryOriginFor(main: boolean, author: string, room: DeliveryOrigin): TurnOrigin {
    return { ...opsOriginFor(main, author, room), fromDelivery: true };
}

/**
 * 一条投递该怎么执行（纯函数，##377 第 27 刀 —— 忙时发送语义统一的唯一判据）。
 *
 * 背景：侧边栏忙时发言进**投递队列**（看得见的"排队中"），任务页忙时按 Enter 却进
 * **插话队列**（`_su*` 块）且**不落 room** ⇒ 同一句话换一个入口就查不到（房间页 / `room get` 里没有）。
 *
 * 统一口径：**每一句话都先落 room**（`say` 事件 = 消息真源），忙不忙只决定**投递方式**：
 *   · 空闲 ⇒ 开一轮（`turn`，能拿到属于这条消息的回复）；
 *   · 忙   ⇒ **插进正在跑的那一轮**（`steer`，下一步生效；回复属于那一轮，不单列）。
 *
 * 为什么不用"排队等它跑完再开一轮"：那会**丢掉插话能力** —— agent 正在做错事时，
 * 用户的纠正只能等三分钟。而插话正是这条会话本来就有的能力（`steer-queue`）。
 */
export type DeliveryPlan = { kind: "turn" } | { kind: "steer"; note: string };

/** `steer` 计划的标准说明（UI 徽章的 title / 界面上的人话） */
export const STEERED_NOTE = "已插入正在跑的轮次（下一步生效，回复见那一轮）";

export function deliveryPlanFor(busy: boolean): DeliveryPlan {
    return busy ? { kind: "steer", note: STEERED_NOTE } : { kind: "turn" };
}

/**
 * 房间 id → **人读得懂的短名**（气泡标记用）。
 *
 * `projects/1/tasks/3` ⇒ `#3`（任务号是房间里所有人都认识的称呼）；
 * `agent:room:ui/sidebar-dev-ttipba` ⇒ `dev-ttipba`（侧边栏实例短名）；
 * 其它形态退到末段。**纯函数 + 单测**：气泡上那个标记不许出现路径噪音。
 */
export function roomDisplayName(roomId: string): string {
    const parts = roomId.split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? roomId;
    if (parts.length >= 3 && parts[parts.length - 2] === "tasks") return `#${last}`;
    // ⚠️ 用**最后一个 `/` 段**而不是 `lastSegment`（那个按 `:` 切）：侧边栏 id 形如
    // `agent:room:ui/sidebar-dev-ttipba` —— 按 `:` 切会得到 `ui/sidebar-dev-ttipba`（把路径带进气泡）。
    return last.replace(/^sidebar-/, "") || roomId;
}

/**
 * 气泡上的「房间投递」标记文案；`null` = 不画（老数据 / 本任务本人发言）。
 *
 * 只写**来源**不写原因：这条 user 块在接收方会话里的语义就是「有一条别的房间的话投进来了」。
 */
export function deliveryBadge(origin: DeliveryOrigin | null | undefined): string | null {
    if (!origin || !origin.roomId) return null;
    const name = roomDisplayName(origin.roomId);
    return name ? `房间投递 · ${name}` : "房间投递";
}

/**
 * 这条来源要不要**写回接收方自己的房间**（##377 第 24 刀 · 双向可见）。
 *
 * 判据只有一条：**源房间 ≠ 接收方房间**。同一个房间（任务页对主人格自己说话、
 * 侧边栏里对侧边栏成员说话）本来就已经在同一份事件流里，再写一遍就是重复。
 */
export function shouldMirrorRoom(sourceRoomId: string, targetRoomId: string): boolean {
    return Boolean(sourceRoomId) && Boolean(targetRoomId) && sourceRoomId !== targetRoomId;
}

/** 写回接收方房间的两条事件（`say` = 投进去的那句，`reply` = 那一轮的回复）。 */
export type MirrorInput = {
    /** 源房间 + 那条 say（第 23 刀留下的键 —— 投递时落在收件方 user 块的 `meta.room`） */
    origin: DeliveryOrigin;
    /** 接收方的房间 id（= 成员 backend 的 taskUri） */
    targetRoomId: string;
    /**
     * 接收方房间里**拥有那个会话**的成员 id（`agent:main`）。
     *
     * 为什么不是源房间那个成员 id：会话是**按 task 唯一**的（一个 task 一条会话），
     * 那一轮真跑在 `targetRoomId` 的会话里 ⇒ 在**这个房间**的视角，说话的就是它的主人格。
     * （v1 边界：成员是另一个人物、绑同一个 task 时，这里的署名会显示成主人格的名字。）
     */
    targetMemberId: string;
    /** 谁说的（源房间那条 say 的 author） */
    author: string;
    /** 对方看到的那句（已剥 `@` 前缀） */
    text: string;
    /**
     * 那一轮产出的回复。
     *
     * **缺省 = 没有属于这条投递的回复**（##377 第 27 刀）：忙时投递是**插进正在跑的那一轮**，
     * 回复属于那一轮、不记在本次投递名下。此时只写回 `say`（写了话、没有独立回复是事实）。
     */
    replyText?: string;
    /** 会话（= targetRoomId 所对应的 task） */
    taskUri: string;
    turnId?: string;
    error?: string;
    /** 两条事件的 id（纯函数**不造 id、不取时间** —— 那是 main 侧的事，可测性在这里） */
    ids: { say: string; reply: string };
    ts: string;
};

/**
 * 造「写回接收方房间」的两条事件；不该写回 ⇒ `null`。
 *
 * 为什么要有这一步（用户口径：**「不能真正使用」里最硬的一条」**）：
 * 投递只记在**源房间**的事件流里 ⇒ 接收方房间 `room get <它>` 恒为 0 事件 ——
 * 人在这边看见「投过去了」，切到接收方的房间却什么都没有（消息与房间脱节）。
 *
 * 两条事件的形状刻意选成**读侧不会重复画**：
 *   · `say.to` 含接收方主人格 ⇒ `opsOwnsEvent` 判定「ops 流里有它」⇒ 任务页不另画一行；
 *   · `reply.ref.memberUri` = 接收方主人格 ⇒ 同上。
 * 于是任务页视觉**逐字不变**（第 16 刀判据 7 的回归网），而房间读口（`room get` / 房间页 /
 * 未来的未读与上下文）第一次能看见「这条是别的房间投进来的」。
 */
export function mirrorEvents(input: MirrorInput): { say: RoomEvent; reply?: RoomEvent } | null {
    if (!shouldMirrorRoom(input.origin.roomId, input.targetRoomId)) return null;
    const say: RoomEvent = {
        id: input.ids.say,
        ts: input.ts,
        channel: DEFAULT_CHANNEL_ID,
        kind: "say",
        author: input.author,
        to: [input.targetMemberId],
        text: input.text,
        delivered: true,
        origin: input.origin,
    };
    if (input.replyText === undefined) return { say }; // 没有属于这条投递的回复（忙时插话）
    const reply: RoomEvent = {
        id: input.ids.reply,
        ts: input.ts,
        channel: DEFAULT_CHANNEL_ID,
        kind: "reply",
        author: input.targetMemberId,
        to: [input.author],
        text: input.replyText,
        delivered: !input.error,
        ...(input.error ? { error: input.error } : {}),
        sourceTask: input.taskUri,
        ...(input.turnId ? { ref: { memberUri: input.targetMemberId, turnId: input.turnId } } : {}),
        origin: input.origin,
    };
    return { say, reply };
}

/**
 * 写回幂等的**判据**（##377 review2 R1）：目标房间里，这条 say 的两份事件**各自**在不在。
 *
 * 为什么不能只看 `say`：`say` 与 `reply` 是**两次 append**（`record` 各写一行）——
 * 进程崩在两次之间 / 磁盘满 / 第二次 append 抛错，都会留下「有 say 无 reply」。
 * 若幂等判据是「这条 say 已经写回过 ⇒ 整体 return」，那条 reply **永远补不回来**：
 * 房间里从此挂着一条「说了话、没人回」的事件，重跑一百次也一样。
 *
 * 口径与「水位是优化」同族：**补写比漏写安全** —— 重复写已存在的事件没有意义，
 * 而少一条就是永久缺一块。故判据按**每条**算，调用方只补缺的那条。
 */
export function mirrorMissingParts(
    events: readonly RoomEvent[],
    sayId: string,
): { say: boolean; reply: boolean } {
    const mine = sayId ? events.filter((e) => e.origin?.sayId === sayId) : [];
    return {
        say: !mine.some((e) => e.kind === "say"),
        reply: !mine.some((e) => e.kind === "reply"),
    };
}

/** 房间页气泡上的「这条从哪来」标记；`null` = 本房间自己产生的，不画。 */
export function originLabel(origin: DeliveryOrigin | null | undefined): string | null {
    if (!origin || !origin.roomId) return null;
    return `来自 ${roomDisplayName(origin.roomId)}`;
}

/**
 * 「只要成员表」的入参形状 —— 比 `Pick<Room, "members">` 更宽：**接受只读数组**。
 *
 * 为什么需要它：UI 侧的成员表常是 `readonly RoomMember[]`（store 给的都是只读视图），
 * 而这些判据函数一个都不改成员表，纯读 —— 用可变数组签名会逼调用方到处 `[...]` 复制，
 * 既多余又会**每次换引用**（第 19 刀「引用稳定器」那条教训）。`Room` 本身可直接传入。
 */
export type MemberBag = { members: readonly RoomMember[] } | null | undefined;

export function resolveMember(room: MemberBag, nameOrId: string): string {
  const key = nameOrId.trim().replace(/^@+/, "");
  if (!key) return nameOrId;
  const members = room?.members ?? [];
  // ① id 全式（`agent:main` / `human:chen56`）—— 精确，无歧义
  const byId = members.find((m) => m.id === key);
  if (byId) return byId.id;
  // ② name（人物名）：**唯一命中才认**（##377 第 21 刀）
  //    原来 `find(m => m.id === key || m.name === key)` 取第一个 —— 两个任务 agent 同室时
  //    它们的 name **完全相同**（都来自人物名），第一个往往正好是主人格 ⇒ 后进来的成员**永远打不到**。
  //    取不到时原样返回（上层报「没有这个成员」并在提示里给别名），**不猜**。
  const byName = members.filter((m) => m.name === key);
  if (byName.length === 1) return byName[0]!.id;
  // name **有歧义 ⇒ 到此为止，不再往下猜**：否则会滑到「id 末段」那层，
  // 恰好命中某个 id 与 name 同形的新成员（实测：`@deepseek-4.1-flash` 会打到 backend=tasks/2 的那个，
  // 而用户想说的是主人格）—— 那比"报没有"更坏：静默投给了错的人。
  if (byName.length > 1) return nameOrId;
  // ③ 别名（`t3` ← backend 的 taskUri）—— 同类唯一才认
  const byAlias = members.filter((m) => m.kind === "agent" && memberAlias(m) === key);
  if (byAlias.length === 1) return byAlias[0]!.id;
  // ④ **id 末段**也认（##377 第 20 刀）：id 是 `agent:main`，用户凭直觉会打 `@main`。
  const byShort = members.filter((m) => m.kind === "agent" && lastSegment(m.id) === key);
  return byShort.length === 1 ? byShort[0]!.id : nameOrId;
}

/**
 * 成员短别名 —— **从 backend 派生**（`projects/1/tasks/3` → `t3`），不落盘。
 *
 * 为什么必须有它（##377 第 21 刀 lab 实测）：成员 `name` 来自**人物名**，
 * 两个任务 agent 同室时 name **完全相同** ⇒ `@<name>` 打到的是第一个（往往正好是主人格），
 * 而完整 id 里的 `:` 被 `ADDRESS_RE` 排除 ⇒ **没有任何写法能打到后进来的那个成员**（实测 `@agent:x` 被截成 `@agent`）。
 * 别名跟着**会话**走（backend 是唯一真源），与人名正交：改人名不影响寻址，换人设也不影响寻址。
 */
export function memberAlias(m: RoomMember): string | undefined {
    if (m.backend?.type !== "task") return undefined;
    const tail = m.backend.data.taskUri.split("/").filter(Boolean).pop();
    return tail ? `t${tail}` : undefined;
}

/**
 * 该成员此刻**真正能打中的**寻址键（按优先级，去重）—— 「提示给的名字必须真能用」的唯一落点。
 *
 * 顺序：`name`（**房间里唯一时才算键**，否则打了会被 `resolveMember` 判成歧义）→ 别名（`t3`）→ id 末段。
 * - 两个任务 agent 同室时人物名相同 ⇒ `name` 不进候选，别名顶上（##377 第 21 刀实测）；
 * - 单人房间 / 名字唯一 ⇒ `name` 第一，别名的显示交给 `memberLabel`（那里按 agent 数判是否露）。
 */
export function memberKeys(room: MemberBag, m: RoomMember): string[] {
  if (m.kind !== "agent") return [m.name];
  const cand = [m.name, memberAlias(m), lastSegment(m.id)].filter((k): k is string => Boolean(k));
  // **按「真能打中」筛，不自己再写一遍唯一性判断**（##266 review1 R1）：
  // 原来这里对别名 / id 末段无条件放行，而 `resolveMember` 的 ③④ 要求**同类唯一**才认 ⇒
  // 候选里会躺着打不中的键（跨项目同号 `projects/1/tasks/3` + `projects/2/tasks/3` 实测：
  // 两个成员都给出 `@t3`，照着敲被判歧义）。判据只能有一份 —— 就是 `resolveMember` 本身。
  // ⇒ 以后新增寻址写法（如完整 id 形态）只改 `resolveMember` 一处，提示自动跟上。
  return [...new Set(cand.filter((k) => resolveMember(room, k) === m.id))];
}

/** 首选寻址键（= `memberKeys[0]`；理论上恒有值，兜底回 name） */
export function memberKey(room: MemberBag, m: RoomMember): string {
  return memberKeys(room, m)[0] ?? m.name;
}

/** 成员的**可读标签**（`deepseek-4.1-flash·t3`）—— 气泡署名 / 提示用；无别名则回落 name */
export function memberLabel(room: MemberBag, id: string): string {
    const m = room?.members.find((x) => x.id === id);
    if (!m) return shortName(id);
    // 房间里只有主人格一个 agent 时，别名是噪声 —— 单人任务视图与旧版逐字一致（##377 第 17 刀判据 1/7）
    const agentCount = (room?.members ?? []).filter((x) => x.kind === "agent").length;
    if (agentCount <= 1) return m.name;
    // 多 agent：**两把钥匙都给**（##377 review3 R2）—— 认识人名的看人名，要打字的看 `@键`
    const k = memberKey(room, m);
    return k && k !== m.name ? `${m.name}（@${k}）` : m.name;
}

/**
 * 「该打什么名字」的候选清单（**一处真源**）—— 提示与报错共用，别各写一套
 * （##377 review3 R1：两处拼装逐字重复，改一处漏一处）。
 * 格式 `@t3(deepseek-4.1-flash)`：**前面是可打的键、括号里是人名**。
 */
export function memberOptions(room: MemberBag, limit = 4): string[] {
    return (room?.members ?? [])
        .filter((m) => m.kind === "agent")
        // 一个键都打不中的成员（跨项目同号 + 同人物名，两条同时成立）**不进候选**：
        // 给了也是白给，而且会让「可选：@t3」自己打不中（review1 R1 的原病灶）。
        .filter((m) => memberKeys(room, m).length > 0)
        .slice(0, limit)
        .map((m) => {
            const k = memberKey(room, m);
            // 键与人物名不同 ⇒ 名字放进括号（「该打什么」在前，「他是谁」在后）
            return k && k !== m.name ? `@${k}(${m.name})` : `@${m.name}`;
        });
}

/**
 * 收件人在**提示 / 报错**里的写法：`agent:main` → `@main`。
 * `@` 后面空名字（`room post --to "@"`）不能渲染成 `@@`（##377 review3 R5）。
 */
export function addrDisplay(nameOrId: string): string {
  const k = nameOrId.trim().replace(/^@+/, "");
  return k ? `@${shortName(k)}` : "@（名字为空）";
}

/** 成员显示名（找不到就回落到 id —— 绝不显示空） */
export function memberName(room: MemberBag, id: string): string {
  return room?.members.find((m) => m.id === id)?.name ?? shortName(id);
}

/**
 * id 的**末段**（`agent:dev` → `dev`）。
 *
 * ⚠️ 「显示用的短名」与「`@` 短名匹配」必须是**同一把尺**（##377 review3 R3）：
 * 原来 `shortName` 取「第一个 `:` 之后剩余全部」（`agent:foo:bar` → `foo:bar`），
 * 而 `resolveMember` 取 `split(":").pop()`（→ `bar`）⇒ 显示的是 `foo:bar`、能打的是 `bar`。
 * 两段 id 上无差别，但一旦出现三段就会「提示的名字打不中」。收敛到这里。
 */
export function lastSegment(id: string): string {
  const i = id.lastIndexOf(":");
  return i >= 0 ? id.slice(i + 1) : id;
}

/** `agent:dev` → `dev`（正文前缀 / 气泡署名要短，模型与人都读得住） */
export const shortName = lastSegment;

/** id → 稳定散列（配色 / 头像兜底都靠它：同一身份到哪都一样） */
function idHash(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

const COLORS = ["#7c9cbf", "#c0a06a", "#8fbf7c", "#bf7c9c", "#9c7cbf", "#6abfc0", "#bfa07c", "#7cbfa0"];

/** 成员底色：显式 `color` 优先，否则按 id 稳定取模（同一身份到哪都同色） */
export function memberColor(m: Pick<RoomMember, "id" | "color">): string {
    if (m.color) return m.color;
    return COLORS[idHash(m.id) % COLORS.length]!;
}

/** 头像池（emoji；数量够一屋子人不撞） */
export const MEMBER_AVATARS = [
    "🧑‍🚀", "🦊", "🐼", "🦉", "🐙", "🐧", "🐝", "🦁",
    "🐨", "🐳", "🦄", "🐯", "🐸", "🦋", "🐺", "🐢",
];

/**
 * 成员头像：显式 `avatar` 优先；否则**按成员在房间里的位次**取池子（`index`）——
 * 位次分配保证同一房间内人人不同（id 散列会撞，视觉上"两个人一个头像"最刺眼）。
 * `index < 0`（拿不到位次，如外部主体）回落到 id 散列。
 */
export function memberAvatar(m: Pick<RoomMember, "id" | "avatar">, index = -1): string {
    if (m.avatar) return m.avatar;
    const i = index >= 0 ? index : idHash(m.id);
    return MEMBER_AVATARS[i % MEMBER_AVATARS.length]!;
}

/** 房间的展示顺序（人先、agent 后；同 kind 保持加入顺序）—— 成员栏与头像位次都用它 */
export function orderedMembers(room: MemberBag): RoomMember[] {
    const ms = room?.members ?? [];
    return [...ms.filter((m) => m.kind === "human"), ...ms.filter((m) => m.kind === "agent")];
}

/**
 * 投递给 agent 的**正文包装**。
 *
 * 为什么必须有：agent 在**自己的 task 会话**里看到这条 user 消息时，上下文里没有任何
 * "这是从房间来的、谁在说"的线索（wire 层身份只有正文有效 —— ##166 §16.2 实测模型不读
 * `name` 一类字段）。故把「房间 / 说话人」压进正文开头一行。
 *
 * ⚠️ 本切片的临时形态（探索优先）：将来接 §24 四元组 / 结构化出口时换成正规载荷。
 */
export function deliveryText(opts: {
    roomId: string;
    fromName: string;
    text: string;
    toAll?: boolean;
    /**
     * **主人格**投递（##166 §28.7 G 推论 3）：正文就是原话，**不加任何包装**。
     *
     * 理由：主人格的会话 = **宿主任务自己的会话**，而"直接在任务聊天里说话"本来就是
     * 这个任务的人说的 —— 包一层「[多人房间 …] chen56 对你说」反而把它变成了外来消息。
     * 这也是「不加人时行为与旧版完全一致」在**正文层**的落点（§28.7 G 推论 4）。
     */
    plain?: boolean;
}): string {
    const head = opts.plain
        ? opts.text
        : `${opts.toAll ? `[多人房间 ${opts.roomId} · 群发]` : `[多人房间 ${opts.roomId}]`} ${opts.fromName} 对你说：\n${opts.text}`;
    // ⚠ 正文**只留人话**（##377 第 26 刀）：房间近期发言改走 `runtime.room.recent`（结构化变量单元），
    //   不再拼在正文尾部 —— 拼在正文里会进会话史（压缩模型会当人话改写）、回放分不清谁说的。
    return head;
}

/** 「近期发言」的一条（已在投递侧剥成纯文本，UI 只读不解析） */
export interface RoomContextItem {
    /** 事件 id（水位 / 去重的外部键） */
    id: string;
    /** 发言者成员 id */
    author: string;
    /** 发言时刻（ISO，事件原样） */
    at: string;
    text: string;
}

/**
 * 「本房间近期发言」段的**上限**（##166 §44.6 四.4）。
 *
 * 与 §28.I 待拍 8「上层只透传 L1」同一取舍：**不让 room 噪声淹掉成员会话**。
 * 两条同时生效，各自截断，都取**最近的**（旧的丢，末尾标注条数）。
 */
export const CONTEXT_MAX_EVENTS = 20;
export const CONTEXT_MAX_CHARS = 4000;

/**
 * 算「自上次这个成员被投递以来，房间里**别人**说了什么」（##166 §44.6 四）。
 *
 * 四条判据全在这里（投递器只负责调用，不另写一份）：
 *   ① 水位：从 `lastSeen[memberId]` **在流里的位置**往后取（不按 id 比大小，见 `RoomSchema.lastSeen`）；
 *   ② 不重复：本条 `sayId` 已通过 `<text>` 给了收件人 ⇒ 跳过；
 *   ③ 不看自己：`author === memberId` 的（它自己说过的话，它自己的会话里有）⇒ 跳过；
 *   ④ 上限：最多 `CONTEXT_MAX_EVENTS` 条 / `CONTEXT_MAX_CHARS` 字符，超出取**最近的**。
 *
 * ⚠️ 空正文事件（失败的 reply）不占位 —— 它没有信息量，进了只会挤掉真的话。
 */
export function roomContextFor(opts: {
    events: readonly RoomEvent[];
    memberId: string;
    /** 本次投递的那条 say */
    sayId: string;
    /** 该成员已看到过的事件 id（缺省 = 从头看） */
    lastSeenId?: string;
}): { items: RoomContextItem[]; omitted: number } {
    const { events, memberId, sayId } = opts;
    // 水位按**流内位置**定位：events.jsonl 是 append-only ⇒ 物理顺序即因果顺序；
    // 找不到（老房间 / 事件被清过）⇒ 从头算，最多吐上限条。
    const start = opts.lastSeenId ? events.findIndex((e) => e.id === opts.lastSeenId) : -1;
    const tail = events
        .slice(start + 1)
        .filter((e) => e.id !== sayId)
        .filter((e) => e.author !== memberId)
        .filter((e) => e.text.trim().length > 0);
    const items: RoomContextItem[] = [];
    let chars = 0;
    for (let i = tail.length - 1; i >= 0; i--) {
        if (items.length >= CONTEXT_MAX_EVENTS) break;
        const e = tail[i]!;
        const cost = e.text.length + e.author.length + 8; // 8 ≈ 分隔符与名字开销的量级
        if (chars + cost > CONTEXT_MAX_CHARS && items.length > 0) break;
        items.unshift({ id: e.id, author: e.author, at: e.ts, text: e.text });
        chars += cost;
    }
    return { items, omitted: tail.length - items.length };
}

/**
 * 房间上下文的**两个 runtime 原子单元**（##377 第 26 刀）：
 *   `room.members` —— 低频（谁在房里 / 别名 / 是否主人格；改成员才变）
 *   `room.recent`  —— 高频（有人说话就变）
 *
 * 为什么**必须拆成两个 place**：runtime 的增量判定是 `renderedHash` **按 place 逐条比**
 * （`shared/context/projection.ts`）。合成一个单元的话，某个成员改个名就会把整段 recent
 * 一起重发一遍 diff —— 白烧 token，还把"房间上下文"变成高频消息流。
 *
 * ⚠ 这里只产出**结构化值**，不产出任何拼好的中文：拼装归模版层（信封由通用渲染器出 YAML）。
 *   在值里塞一段拼好的话 = 没法裁、没法 diff、也没法与 ##268 的 plan 对齐。
 */
export interface RoomMembersValue {
    /** 房间 id（本任务自己的房间 = 任务 URI；投递轮可能是**来源**房间） */
    roomId: string;
    /** 房间显示名（`#N` / 侧边栏短名，`roomDisplayName` 同一把尺） */
    name: string;
    /** 成员（**低频**）：`key` = 此刻真能打中的 `@` 键（`memberKey`，与补全/解析同一份判据）。
     *  字段名用 `list` 而不是 `members`：单元本身已叫 `room.members`，再套一层会成
     *  `room.members.members`（模型与人都会读糊涂）。 */
    list: Array<{ id: string; name: string; key: string; main: boolean }>;
}

export interface RoomRecentValue {
    /** 自上次以来**别人**的发言（时间正序；不含自己说的、不含正文里这一条） */
    items: Array<{ from: string; at: string; text: string }>;
    /** 因上限被省略的更早条数 */
    omitted: number;
}

/** 成员单元的值（纯函数；单测钉「每个人的 key 都真能打中」） */
export function roomMembersValue(room: Room): RoomMembersValue {
    return {
        roomId: room.id,
        name: roomDisplayName(room.id),
        list: orderedMembers(room).map((m) => ({
            id: m.id,
            name: m.name,
            key: memberKey(room, m),
            main: m.main === true,
        })),
    };
}

/** 近期发言单元的值（`from` 用**能 @ 的键**：模型读到谁说的，就能 @ 回去） */
export function roomRecentValue(
    room: Room,
    items: readonly RoomContextItem[],
    omitted: number,
): RoomRecentValue {
    return {
        items: items.map((it) => {
            const m = room.members.find((x) => x.id === it.author);
            return { from: m ? memberKey(room, m) : shortName(it.author), at: it.at, text: it.text };
        }),
        omitted,
    };
}

/** 护栏文案（输入框上方那条）：本条将投递给谁 —— **@ 优先、focus 兜底、都没有 = 未投递** */
export function deliveryHint(
    recipients: readonly string[],
    room: MemberBag,
    routing: RoomRouting,
): string {
    // 笔记（§38.2）：**中性**文案 —— 不是"未投递"，是"本来就没打算投"
    if (recipients.length === 0) return routing === "note" ? "笔记（不投递，只进房间历史）" : "未投递（没有 @ 收件人、也没有当前接受者）";
    // 打错名字（##377 第 20 刀）：`@a` 这种解析不出来的会被原样放进 recipients ⇒ 别显示
    // "将投递给 a"（实测会这样，与后端「房间里没有这个成员」自相矛盾）—— 当场给可选名。
    const known = new Set((room?.members ?? []).map((m) => m.id));
    const unknown = recipients.filter((r) => !known.has(r));
    if (unknown.length > 0) {
        const shown = unknown.map(addrDisplay).join(" / ");
        const names = memberOptions(room);
        return names.length > 0 ? `${shown} 不是房间成员（可选：${names.join(" / ")}）` : `${shown} 不是房间成员`;
    }
    if (recipients.length === 1) return `将投递给 ${memberLabel(room, recipients[0]!)}`;
    const names = recipients.map((r) => memberLabel(room, r)).join(" / ");
    const head = routing === "all" ? "群发" : "将投递给";
    return `${head} ${names}（${recipients.length} 个成员 —— 显式多收件人 = ${recipients.length} 倍 token 成本）`;
}

/** 投递状态的中文（UI 一处真源；别在组件里各写一套 if） */
export function deliveryStatusText(s: DeliveryStatus): string {
    switch (s) {
        case "queued":
            return "排队中";
        case "running":
            return "投递中";
        case "ok":
            return "已投递";
        case "failed":
            return "未投递";
        case "skipped":
            return "未投递（不是可投递成员）";
    }
}

/** 徽章上的短标记（`note` 有值时补一句 —— 别让"已投递却没有回复"看起来像丢了） */
const NOTE_SHORT = "插进本轮";

/**
 * 徽章文案 = 状态 +（`note` 有值时的短标记）。三处 UI（任务页 / 房间页 / 侧边栏）共用这一份，
 * 别各自拼字符串（第 12 刀踩坑 37：同一句话写三遍，改一处漏两处）。
 */
export function deliveryStateText(d: Pick<DeliveryState, "status" | "note">): string {
    const base = deliveryStatusText(d.status);
    return d.note ? `${base}（${NOTE_SHORT}）` : base;
}
