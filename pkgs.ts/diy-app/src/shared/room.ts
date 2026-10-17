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

/** 房间 id（= 目录名，故限制字符集；中文标题走 `title`，不塞 id） */
export const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

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
  role: z.string().optional(),
  color: z.string().optional(),
  /** 头像（emoji）。留空 = 按成员在房间里的位置自动分配（`memberAvatar`） */
  avatar: z.string().optional(),
});
export type RoomMember = z.infer<typeof RoomMemberSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  /**
   * 当前接受者（成员 id）。**一等字段、必须落盘、全成员可见**（§28.5 B 推论 2）——
   * 否则人 / agent 都不知道自己在跟谁说话。null = 未设（此时无 `@` 的发言一律未投递）。
   */
  focus: z.string().nullable(),
  members: z.array(RoomMemberSchema),
  created: z.string(),
  updated: z.string(),
});
export type Room = z.infer<typeof RoomSchema>;

/**
 * 一条发言的投递依据：`explicit` = 显式 `@X`；`all` = 显式 `@all`（群发）；
 * `focus` = 隐式当前接受者；`none` = 都没（只落盘）。
 */
export const RoomRoutingSchema = z.enum(["explicit", "all", "focus", "none"]);
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
 * 名字允许 `[A-Za-z0-9_.\-/:]`（够覆盖 `dev` / `human:chen56` / `agent:dev` / `all`）。
 *
 * **可连写多个**（本切片按用户口径扩的）：`@dev @review 一起看下` ⇒ 两个收件人、正文「一起看下」。
 * 分隔只认空白 / 逗号 / 顿号（不认冒号 —— `@dev: 你好` 里的冒号是正文标点，历史上一直如此）。
 */
export function parseAddress(text: string): { text: string; tos: string[] } {
    const re = /^\s*@([A-Za-z0-9_.\-/:]+)\s*[,，、]?\s*/;
    const tos: string[] = [];
    let rest = text;
    for (;;) {
        const m = re.exec(rest);
        if (!m) break;
        tos.push(m[1]!);
        rest = rest.slice(m[0].length);
    }
    if (tos.length === 0) return { text, tos };
    // 只喊人、没正文（`@dev`）⇒ 保留原文，不产生空正文
    return rest.trim() ? { text: rest, tos } : { text, tos };
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
): { recipients: string[]; routing: RoomRouting } {
  const explicit = (to ?? []).filter((t) => !!t);
  if (explicit.length > 0) {
    const hasAll = explicit.some(isAllAddress);
    const named = explicit.filter((t) => !isAllAddress(t));
    const agents = members.filter((m) => m.kind === "agent").map((m) => m.id);
    return { recipients: [...new Set([...named, ...(hasAll ? agents : [])])], routing: hasAll ? "all" : "explicit" };
  }
  if (focus) return { recipients: [focus], routing: "focus" };
  return { recipients: [], routing: "none" };
}

/**
 * 名字或 id → 成员：`@dev` / `dev` / `agent:dev` 都认；不认得就原样返回（外部主体 / 未来扩展）。
 *
 * 前导 `@` 一律剥掉：命令行的 `--member @review` 与正文里的寻址写法是**同一个直觉**
 * （实测踩到：不剥时 `@review` 会被当成一个陌生名字而报"房间里没有这个成员"）。
 */
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
export function deliveryText(opts: { roomId: string; fromName: string; text: string; toAll?: boolean }): string {
    const tag = opts.toAll ? `[多人房间 ${opts.roomId} · 群发]` : `[多人房间 ${opts.roomId}]`;
    return `${tag} ${opts.fromName} 对你说：\n${opts.text}`;
}

/** 护栏文案（输入框上方那条）：本条将投递给谁 —— **@ 优先、focus 兜底、都没有 = 未投递** */
export function deliveryHint(
    recipients: readonly string[],
    room: Pick<Room, "members"> | null | undefined,
    routing: RoomRouting,
): string {
    if (recipients.length === 0) return "未投递（没有 @ 收件人、也没有当前接受者）—— 只有自己能看到";
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
