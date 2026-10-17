// src/shared/room.ts
// 🎯 多人房间（room）契约 —— main（投递器）/ RPC / UI / CLI 四方共用。
//
// 设计真源：##166 §28（room 核心设计骨架 + §28.5 定案）·段；开发日志见 ##377。
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
  /** 全局 id 短式（接 §25 `<ns>:<type>:<path>`）：`human:ccc` / `agent:dev` */
  id: z.string(),
  /** 显示名（气泡署名 / `@` 寻址用） */
  name: z.string(),
  kind: RoomMemberKindSchema,
  /** 人的会话不在 task 里（§28.6 待决 76 未定案）—— 最小切片给 null */
  backend: RoomBackendSchema.nullable(),
  role: z.string().optional(),
  color: z.string().optional(),
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

/** 一条发言的投递依据：explicit = 显式 `@`；focus = 隐式当前接受者；none = 都没（只落盘） */
export const RoomRoutingSchema = z.enum(["explicit", "focus", "none"]);
export type RoomRouting = z.infer<typeof RoomRoutingSchema>;

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
  /** 是否真投递出去了（false = 未投递 / 投递失败，UI 必须显式标出，不许静默丢弃，§28.5 B 推论 3） */
  delivered: z.boolean(),
  /** 投递失败原因（人话）；delivered=false 且有它 = 有话说不出 */
  error: z.string().optional(),
  /** 该回复来自哪个 task 会话（`reply` 事件带；审计用 —— 判据 3 的证据链） */
  sourceTask: z.string().optional(),
});
export type RoomEvent = z.infer<typeof RoomEventSchema>;

// ─── 纯函数（main 与 UI 共用同一份判据）─────────────────────────────

/**
 * 解析正文**开头**的 `@名字`（原型见 ##166 §27.3 可挑资产 / 搁置分支 `core/room.ts::parseAddress`）。
 *
 * 只认开头（不是"正文里出现过 @"）—— 否则「我觉得 @reviewer 说得对」会被误判成寻址。
 * 名字允许 `[A-Za-z0-9_.\-/:]`（够覆盖 `dev` / `human:ccc` / `agent:dev`）。
 */
export function parseAddress(text: string): { text: string; to?: string } {
  const m = /^\s*@([A-Za-z0-9_.\-/:]+)\s*[,，:：]?\s*/.exec(text);
  if (!m) return { text };
  const to = m[1]!;
  const rest = text.slice(m[0].length);
  // `@dev` 后面什么都没有（只为了喊一声）⇒ 保留原文，不产生空正文
  return rest ? { text: rest, to } : { text };
}

/**
 * 投递判据（§28.5 B 的 `resolveRecipients`，一字不改地落成代码）：
 *
 * ```
 * evt.to?.length ? evt.to          // ① 显式 @ 优先（可多个）
 * : focus        ? [focus]         // ② 无 @ 时投给「当前接受者」
 * :                []              // ③ 都没有 → 只落盘、不投递
 * ```
 *
 * ⚠️ 协议里**没有「广播」**：要广播必须显式列多个 `to` ⇒ 成本从「默认 N 倍」变成「显式 N 倍」。
 */
export function resolveRecipients(
  to: readonly string[] | undefined,
  focus: string | null | undefined,
): { recipients: string[]; routing: RoomRouting } {
  const explicit = (to ?? []).filter((t) => !!t);
  if (explicit.length > 0) return { recipients: [...new Set(explicit)], routing: "explicit" };
  if (focus) return { recipients: [focus], routing: "focus" };
  return { recipients: [], routing: "none" };
}

/** 名字或 id → 成员：`@dev` → `agent:dev`；不认得就原样返回（外部主体 / 未来扩展） */
export function resolveMember(room: Pick<Room, "members"> | null | undefined, nameOrId: string): string {
  const hit = room?.members.find((m) => m.id === nameOrId || m.name === nameOrId);
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

const COLORS = ["#7c9cbf", "#c0a06a", "#8fbf7c", "#bf7c9c", "#9c7cbf", "#6abfc0", "#bfa07c", "#7cbfa0"];

/** 成员底色：显式 `color` 优先，否则按 id 稳定取模（同一身份到哪都同色） */
export function memberColor(m: Pick<RoomMember, "id" | "color">): string {
  if (m.color) return m.color;
  let h = 0;
  for (const ch of m.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
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
export function deliveryText(opts: { roomId: string; fromName: string; text: string }): string {
  return `[多人房间 ${opts.roomId}] ${opts.fromName} 对你说：\n${opts.text}`;
}

/** 护栏文案：本条将投递 N 个成员（§28.5 B 末尾；N>1 时显式提示 N 倍成本） */
export function deliveryHint(recipients: readonly string[], room: Pick<Room, "members"> | null | undefined): string {
  if (recipients.length === 0) return "未投递（没有 @ 收件人、也没有当前接受者）—— 只有自己能看到";
  if (recipients.length === 1) return `将投递给 ${memberName(room, recipients[0]!)}`;
  const names = recipients.map((r) => memberName(room, r)).join(" / ");
  return `将投递给 ${names}（${recipients.length} 个成员 —— 显式多收件人 = ${recipients.length} 倍 token 成本）`;
}
