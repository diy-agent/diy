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

/**
 * 是否画署名行。
 *
 * ⚠️ 与对齐**不完全同源**（##266 review1 R2）：`bubbleAlignClass` 在 `author || room` 时左对齐，
 * 这里只看 `author` ⇒ 「有 room 无 author」会左对齐但不署名。
 * 今天不会出现这种块：`opsOriginFor`（`shared/room`）的不变量是「不署名 ⇒ 整条随附事实都不落」，
 * 即 **room 恒伴 author**。这里判 room 只是为了兜底（万一以后有人放宽那条不变量），
 * 别把它当成"两条判据一致"的证明。
 */
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

/**
 * 是否画「房间投递」标记。
 *
 * 与 `hasAuthor` 是两个独立事实：一条块可以**有署名无来源**（人手打的 `--author`）——
 * 那时左对齐 + 署名、但不画「房间投递」标记。今天 room 投递恒带 author + 来源
 * （`opsOriginFor`），所以两者同行出现；**别据此把两个函数合并**。
 */
export function hasDelivery(attrs: Record<string, unknown> | null | undefined): boolean {
    return roomOriginOf(attrs) !== null;
}
