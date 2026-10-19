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
  ts: z.string(),
});
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

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

export function resolveMember(room: Pick<Room, "members"> | null | undefined, nameOrId: string): string {
  const key = nameOrId.trim().replace(/^@+/, "");
  const hit = room?.members.find((m) => m.id === key || m.name === key);
  return hit ? hit.id : nameOrId;
}

/** 成员显示名（找不到就回落到 id —— 绝不显示空） */
export function memberName(room: Pick<Room, "members"> | null | undefined, id: string): string {
  return room?.members.find((m) => m.id === id)?.name ?? shortName(id);
}

/** `agent:dev` → `dev`（正文前缀 / 气泡署名要短，模型与人都读得住） */
export function shortName(id: string): string {
  const i = id.indexOf(":");
  return i >= 0 ? id.slice(i + 1) : id;
}

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
export function orderedMembers(room: Pick<Room, "members"> | null | undefined): RoomMember[] {
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
    if (opts.plain) return opts.text;
    const tag = opts.toAll ? `[多人房间 ${opts.roomId} · 群发]` : `[多人房间 ${opts.roomId}]`;
    return `${tag} ${opts.fromName} 对你说：\n${opts.text}`;
}

/** 护栏文案（输入框上方那条）：本条将投递给谁 —— **@ 优先、focus 兜底、都没有 = 未投递** */
export function deliveryHint(
    recipients: readonly string[],
    room: Pick<Room, "members"> | null | undefined,
    routing: RoomRouting,
): string {
    // 笔记（§38.2）：**中性**文案 —— 不是"未投递"，是"本来就没打算投"
    if (recipients.length === 0) return routing === "note" ? "笔记（不投递，只进房间历史）" : "未投递（没有 @ 收件人、也没有当前接受者）";
    if (recipients.length === 1) return `将投递给 ${memberName(room, recipients[0]!)}`;
    const names = recipients.map((r) => memberName(room, r)).join(" / ");
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
