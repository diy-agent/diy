/**
 * turn-gate.ts — 「这个会话现在能不能开一轮」的**准入扩展点**（##400，纯类型 + 零依赖）。
 *
 * 【为什么是扩展点，而不是一条写死的判据】
 *   需求原话：「agent 应该是不依赖 task 的，不然以后啥 session 都要 agent 去理解，应该有个
 *   机制依赖倒置吧」。于是内核（`LocalAgentManager`）**只问一句「能不能开轮」**，
 *   而「什么算不能开」由**上层策略**注入：
 *     · 内核不知道 task、不知道任务状态、不许 import 任务模块（依赖方向：服务 → 内核 反了）；
 *     · 提示词里也不写「任务已结案就别干活」这类话 —— 那会把叙述上下文变成
 *       「每个 session 类型都要 agent 学一遍」，而且模型可以不遵守、无法测试。
 *
 * 【形状（与 `rule.discriminated-union` 一致）】
 *   判别键 `allow` 同级 = 公共字段；拒绝分支的私有数据（`code` / `reason` / `detail`）平铺在
 *   同级 —— 这是一个只有两个分支、无嵌套的判别联合，不值得再套一层 `data`。
 *
 * 【默认零影响】
 *   内核的 `turnGate` 是**可选项**：不注入 ⇒ 一举都不问，行为与改动前逐字节一致
 *   （单测「假 gate 全 allow / 不注入」双向钉住）。
 */

/** 一次开轮请求：会话身份 + 开轮方式（内核**只**需要这两样，别的一概不传） */
export interface TurnGateInput {
    /** 会话 URI（生产里就是任务 URI；内核不解释它） */
    sessionUri: string;
    /** 开轮方式：`chat` 直接开一轮 · `queued` 用队列现有内容开一轮 · `steer` 唤醒一条待投递留言 */
    kind: "chat" | "queued" | "steer";
}

/** 拒绝的载荷：`code` 供日志/统计（`<域>/<kebab-case>`），`reason` 是给用户的一句话 */
export type TurnGateDecision =
    | { allow: true }
    | { allow: false; code: string; reason: string; detail?: string };

/**
 * 准入策略：**同步纯函数**（内核在 `chat()` 最开头调它，早于读盘与模型解析）。
 *
 * 同步的理由：它决定的是"要不要继续"，而 `chat()` 是 async generator —— 在此处 await 一个
 * 任意策略会把「拒绝」也变成一次可失败、可取消的异步动作，白白扩大失败面。
 * 策略要查的状态必须已在内存 / 便宜可得（任务状态 = 读一份小 frontmatter）。
 */
export type TurnGate = (input: TurnGateInput) => TurnGateDecision;

// ═══════════════════════════════════════════════
//  终态会话（判据的**共享词表**；策略与 UI 从这里取，别各写一份）
// ═══════════════════════════════════════════════

/**
 * **终态**：会话不再接受新的轮次。
 *
 * `done` 结案 · `cancelled` 取消 · `closed` 归档（历史词表里 `archived` 的等价物 ——
 * `TASK_STATES` 只有 `closed`，不要为一个别名改枚举）。
 * **`shelved` 不在此列**：搁置可以重新激活，会话仍可续。
 */
export const TERMINAL_SESSION_STATES = ["done", "cancelled", "closed"] as const;

export type TerminalSessionState = (typeof TERMINAL_SESSION_STATES)[number];

/** 状态 → 给人看的一句话（server 拒绝文案与 UI 静态提示**同一份** —— 改口径只改这里） */
export const TERMINAL_STATE_REASON: Record<TerminalSessionState, string> = {
    done: "任务已结案",
    cancelled: "任务已取消",
    closed: "任务已归档",
};

/** 该状态是不是终态（入参是宽松 string：任务头部字段读侧宽容，未知值一律放行） */
export function isTerminalSessionState(state: string | null | undefined): state is TerminalSessionState {
    return !!state && (TERMINAL_SESSION_STATES as readonly string[]).includes(state);
}

/**
 * 「怎么续」的详情文案（**唯一一份**）：被拒的 server 回执与任务页静态提示都用它。
 * 带具体 uri（用户能原样复制去跑）。
 */
export function terminalSessionDetail(sessionUri: string, state: string): string {
    return (
        `本任务当前状态为 ${state}，不再接受新的轮次（历史仍可查看）。\n` +
        `继续请新建任务；要续用本任务，先执行：diy task edit ${sessionUri} active`
    );
}
