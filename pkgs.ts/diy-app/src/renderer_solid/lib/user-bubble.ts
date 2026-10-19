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
 */
export function bubbleAlignClass(author: string | null | undefined): string {
    return author ? "flex justify-start" : "flex justify-end";
}

/** 是否画署名行（与对齐**同源**：有 author 才画 —— 两处判据分家就会出现"左对齐但没说是谁"） */
export function hasAuthor(author: string | null | undefined): boolean {
    return Boolean(author);
}
