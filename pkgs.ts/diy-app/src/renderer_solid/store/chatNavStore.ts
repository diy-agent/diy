/**
 * chatNavStore — 跨组件的「去会话并定位到某一处」待办（##408 作业来源 / ##436 信箱跳转共用）。
 *
 * 为什么要一份**待办**而不是直接调：发起方（作业面板 / 信箱面板）只拿得到 `taskUri` 与锚点，
 * **拿不到**会话页的滚动容器与块树；而会话页可能是**整页新挂**（先 `openTaskRun` 切页），
 * 挂载那一刻锚点数据还没到。中间没有一份 latest-wins 的待办 ⇒ 时序不稳定（有时跳有时不跳）。
 *
 * 三条口径：
 *   · **latest-wins**：新的请求覆盖旧的（用户最后一次点击才算数）；
 *   · **取走即清**：定位是一次性动作 —— 留着会让每次切回该任务都重新跳一次（= 抢滚动）；
 *   · **按 taskUri 匹配**：请求只对那个任务生效，切到别的会话时原地等着。
 *
 * 为什么从 `jobRunsStore` 里搬出来：它的语义是"给会话页的导航请求"，与作业快照的轮询
 * 生命周期毫无关系；##436 的信箱跳转要复用它，塞在 job 表里就成了"信箱依赖作业面板"。
 * `jobRunsStore` 的 `requestNav / pendingNav / takeNav` 保留为**转发**（旧调用点不动）。
 */

import { createSignal } from "solid-js";

export interface ChatNavTarget {
    taskUri: string;
    /** 谁发起的（提示文案用：`job` = 作业来源 · `inbox` = 通知信箱） */
    origin: "job" | "inbox";
    /** 轮次 id（有就直接滚到那一轮） */
    turnId?: string;
    /** 块 id（工具调用 / 具体消息块） */
    blockId?: string;
    /**
     * 插话队列项 id：块树里找 `attrs.steerId` 命中的那一块（##436）。
     *
     * 为什么需要它：留言投递时块还没生成（它插进的那一轮可能正在跑），只有队列项 id 是
     * **发条目那一刻就有**的锚点原料；等会话页把块树读出来，再拿它反查轮次。
     */
    steerId?: string;
}

const [pending, setPending] = createSignal<ChatNavTarget | null>(null);

export const chatNavStore = {
    /** 请求一次「去那个会话并滚到这儿」（latest-wins） */
    request(target: ChatNavTarget): void {
        setPending(target);
    },
    /** 反应式读取（会话页 effect 用它；不改状态） */
    get pending(): ChatNavTarget | null {
        return pending();
    },
    /** 取走属于该任务的请求（取走即清，不重复跳） */
    take(taskUri: string): ChatNavTarget | null {
        const p = pending();
        if (!p || p.taskUri !== taskUri) return null;
        setPending(null);
        return p;
    },
    /** 清空（测试 / 退出登录态） */
    reset(): void {
        setPending(null);
    },
};
