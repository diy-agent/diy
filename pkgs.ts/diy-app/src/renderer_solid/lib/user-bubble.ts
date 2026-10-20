import type { DeliveryOrigin } from "../../shared/room";

/**
 * 用户气泡的**呈现判据**（纯函数，零 DOM）。
 *
 * 为什么抽出来（##329 R1 的教训：UI 语义判据抽纯函数 + 单测，别靠 CDP 手测）：
 * "有署名 ⇒ 左对齐、无署名 ⇒ 右对齐"是**语义**，不是样式细节 —— 它表达的是
 * 「这句话**不是我说的**」（别人/别的 agent 投递进本任务会话的话）。
 * 靠手测只能证明"这一次画对了"，抽成纯函数后改坏了立刻红。
 *
 * 数据来源：user 块的 `meta.author`（##377 第 14 刀 / ##166 §40）—— 值是**成员 id**
 * （`agent:166` / `human:chen56`），不是自由字符串；空/缺省 = 本任务本人发言。
 * 第 23 刀起还有 `meta.room`（`{ roomId, sayId }`）：**从哪个房间投过来的**。
 * 两者任一存在 ⇒ 左对齐（都是"这句话在本会话里不是我说的"），见 `bubbleAlignClass`。
 */
export function bubbleAlignClass(author: string | null | undefined, room?: DeliveryOrigin | null): string {
    return author || room ? "flex justify-start" : "flex justify-end";
}

/** 是否画署名行（与对齐**同源**：有 author 才画 —— 两处判据分家就会出现"左对齐但没说是谁"） */
export function hasAuthor(author: string | null | undefined): boolean {
    return Boolean(author);
}

/**
 * user 块 attrs 里的**房间来源**（##377 第 23 刀）；解析不出 ⇒ `null`。
 *
 * 形状 = `shared/room.DeliveryOrigin`（`{ roomId, sayId }`）。读侧一律走这里，
 * 不让 UI 各处自己 `attrs["room"]` 解构（解错了只会静默变成"没来源"）。
 */
export function roomOriginOf(attrs: Record<string, unknown> | null | undefined): DeliveryOrigin | null {
    const r = attrs?.["room"];
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const roomId = o["roomId"];
    if (typeof roomId !== "string" || !roomId) return null;
    const sayId = o["sayId"];
    return { roomId, sayId: typeof sayId === "string" ? sayId : "" };
}

/** 是否画「房间投递」标记（与左对齐**同源**：有来源就是"别的房间投过来的话"） */
export function hasDelivery(attrs: Record<string, unknown> | null | undefined): boolean {
    return roomOriginOf(attrs) !== null;
}
