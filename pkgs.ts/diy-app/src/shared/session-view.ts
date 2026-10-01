/**
 * session-view.ts — 本地会话「运行态」的呈现判据（纯函数，renderer 与单测共用）
 *
 * 背景（任务 194）：renderer 过去只用**自己的** `running` 去解释会话里的一切，
 * 于是同一根因产出两个相反方向的误报：
 *   假阴性 —— 别人（CLI / 另一窗口）正在跑：本地 running=false → 未收 stop 的块
 *             被当成「本轮未完成（流中断/崩溃恢复）」，而且界面上没有停止入口；
 *   假阳性 —— 自己点停止：本地 running 要等服务端 end 帧才复位，上游慢时按钮一直
 *             卡在停止态，发不出下一条，刷新才恢复。
 *
 * 判据分层（不许再混成一个布尔）：
 *   · remoteActive     —— main 真值：这个任务此刻是否真有轮次在跑（agent.local.running）；
 *   · sending          —— 只是"我这轮在等**自己**的流"，是前者的子集，代表不了整体；
 *   · stopRequestedAt  —— 停止是**本地确定终态**：点了就立刻归位，不等 main 收尾；
 *                         收尾期间 remoteActive 仍可能为 true，一律呈现"停止中"。
 *
 * ⚠️ 不许把"块未收 stop"直接当"直播中"（那会让真崩溃/中断的历史不再可见）：
 *    live 只由「main 报活跃」或「我这轮在途」决定，与块自己的 stopped 无关。
 */

/**
 * 停止宽限期：点停止后 main 若在**这段时间内**完成收尾，一切照常（stopping → 发送）。
 * 超过它 main 仍报活跃 → `stoppingStuck`，UI 把按钮升级成「强制中断」。
 * ⚠️ 它**不是** stopping 的过期时间：stopping 只要 main 仍活跃就一直成立（见 SessionView.stopping），
 * 过期只改变"给不给强制中断出口"。
 */
export const STOP_GRACE_MS = 3000;

export interface SessionSignals {
    /** 本地 send() 在途：我这轮自己发起、正等自己的流 */
    sending: boolean;
    /** main 真值：该 task 此刻有活跃轮次（含别人发起的） */
    remoteActive: boolean;
    /** 已请求停止的时刻（epoch ms）；null = 没点过停止 */
    stopRequestedAt: number | null;
    /** 现在（epoch ms）—— 显式传入，判据才是纯函数、可单测 */
    now: number;
}

export interface SessionView {
    /** 直播中：这一轮还活着（main 说活跃，或我这轮在途）—— 中断警告/等待动画的 gating */
    live: boolean;
    /**
     * 停止中：已请求停止、main 还在收尾。
     *
     * ⚠️ **不设过期**：只要 main 还报活跃就一直算停止中。
     * 曾经用"宽限期 3s"收口，超时就把状态退回 busy —— 那是错的方向：退回去意味着
     * 输入框解锁、发送按钮出现，而服务端仍会拒发（它说的是"正在生成中"），
     * 界面结论与服务端结论相反，用户点了发送只会拿到一条错误。
     * 真卡住时不靠"假装没在停止"给出口，靠 stoppingStuck 给**更强**的出口（见下）。
     */
    stopping: boolean;
    /** 收尾已超宽限期：main 迟迟不落（可能卡在工具里）→ UI 让它能再点一次强制中断 */
    stoppingStuck: boolean;
    /** 还在生成：输入框锁住、按钮位显示"停止" */
    busy: boolean;
}

export function sessionView(s: SessionSignals): SessionView {
    const live = s.sending || s.remoteActive;
    const requested = s.stopRequestedAt !== null;
    const stopping = live && requested;
    // 宽限期只用来区分"正常收尾"与"疑似卡住"，**不再**用来把状态退回"生成中"
    const overdue = requested && s.now - (s.stopRequestedAt as number) >= STOP_GRACE_MS;
    return { live, stopping, stoppingStuck: stopping && overdue, busy: live && !stopping };
}
