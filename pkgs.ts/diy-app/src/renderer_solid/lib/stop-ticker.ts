/**
 * stop-ticker — "停止收尾中"期间的**时钟推进器**（##307 review2 R2）。
 *
 * 为什么需要：停止宽限期判据（shared/session-view.ts 的 `stoppingStuck`）靠**现在**前进才会
 * 从「停止中」翻到「收尾超时 → 可强制中断」。##307 前 `now` 由 2s 轮询每拍推进；轮询删掉后
 * `now` 只在「对 main 真值返回」「点停止」时前进 —— 若 main **卡在工具里**（不发 op、不落
 * 轮次边界），`now` 就冻住，`stoppingStuck` 永为假 → 「强制中断」按钮（它存在的意义正是
 * main 卡住时的更强出口）**成了死代码**。
 *
 * 故在「有任务处于停止收尾」期间保留一个**克制的** tick：它只推进 `now`，不做别的；
 * 没有任务在停止时立即停表（不再空转）。
 *
 * 计时器可注入（`setTimer` / `clearTimer`），故纯逻辑可单测（见 tests/core/stop-ticker.test.ts）。
 */
export interface StopTickerOpts {
    /** 每拍间隔（ms） */
    intervalMs?: number;
    /** 注入计时器（测试用 fake timer；缺省全局 setInterval） */
    setTimer?: typeof setInterval;
    /** 注入清表（测试用；缺省全局 clearInterval） */
    clearTimer?: typeof clearInterval;
}

export class StopTicker {
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly onTick: () => void,
        private readonly opts: StopTickerOpts = {},
    ) {}

    /** 是否在走表 */
    get running(): boolean {
        return this.timer !== null;
    }

    /**
     * 对齐「是否需要走表」。**幂等**：状态未变则不创建/销毁计时器。
     * `needed` 为真 → 开表（若未开）；为假 → 停表（若在走）。
     */
    sync(needed: boolean): void {
        if (needed === this.running) return;
        if (needed) {
            const set = this.opts.setTimer ?? setInterval;
            this.timer = set(this.onTick, this.opts.intervalMs ?? 500);
        } else {
            const clear = this.opts.clearTimer ?? clearInterval;
            clear(this.timer as ReturnType<typeof setInterval>);
            this.timer = null;
        }
    }

    /** 停表（幂等） */
    stop(): void {
        this.sync(false);
    }
}
