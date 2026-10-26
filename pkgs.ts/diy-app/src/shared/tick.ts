// 🎯 核心定时器的**判据层**（##408 v2）：一拍多久、什么算一拍、上一拍没跑完时怎么办。
//
// 为什么单独一层：v2 的 watch / 将来的 trigger / 巡检都挂在**同一个**一拍源上。
// 每处各自 `setInterval` 的结果是「同一件事有 N 个相位」—— 30 个 watch 就 30 条
// 相位错开的唤醒，同一秒里打十几次 IO。所以计时器只允许有一个（`main/services/core-ticker.ts`），
// 本文件只管「这一拍该不该跑」。
//
// 三条判据（都在这里钉死，服务层不许再判）：
//   ① **一拍 = 60s**：watch 的 `every` 以分钟为单位，折成拍数就是整数除法，没有小数残留。
//   ② **单飞**：上一拍还没跑完 ⇒ 这一拍**跳过**（不排队、不叠拍）。慢探针的代价是丢拍，
//      不是堆积 —— 堆积会让下一拍面对两份过期的活，且停机后越追越远。
//   ③ **跳拍要能看见**：`skipped` / `lastSkipAt` 是对外可数的（`job metrics` 面/排查用），
//      否则「定时器好像没跑」只能靠猜。
//
// 与 `env-watch` 的关系：那边的 `EnvDiskPoller` 自带 30s `setInterval`（磁盘水位专用，
// 早于本文件）。**不合并** —— 它的语义是「环境条件持续存在」，与 job 域无关；但新代码
// 一律挂本拍源，不再新增独立 interval。

/** 一拍的间隔（ms）。watch 的 `every`（分钟）按它折算成拍数。 */
export const TICK_MS = 60_000;

/** 一拍为什么没跑。目前只有一种：上一拍还在跑。 */
export type TickSkipReason = "busy";

/** `begin()` 的回答：这一拍跑不跑、序号是多少。 */
export type TickDecision =
    | { readonly ran: true; readonly seq: number }
    | { readonly ran: false; readonly seq: number; readonly reason: TickSkipReason };

/** 对外可读的计数快照（`job metrics` / 排查用；不含时间语义，纯数）。 */
export interface TickStats {
    /** 真正跑过的拍数（从 1 起） */
    readonly seq: number;
    /** 因为上一拍没跑完而跳过的拍数 */
    readonly skipped: number;
}

/**
 * 一拍的门：`begin()` 决定跑不跑，`end()` 宣布跑完了。
 *
 * **不是线程安全的** —— 只该在 Electron 主进程的单线程事件循环里用。
 * 若 `begin()` 拿到 `ran:true` 却忘了 `end()`，之后每一拍都会 `busy`：这是刻意的
 * （宁可卡住可见，不可静默叠拍），`reset()` 只在测试里用。
 */
export class TickGate {
    private seq = 0;
    private skipped = 0;
    private busy = false;
    private lastSkipTime: number | null = null;

    /** 申请一拍。`at` 只用于记录最后一次跳拍的时刻（判据不用时间）。 */
    begin(at: number = Date.now()): TickDecision {
        if (this.busy) {
            this.skipped += 1;
            this.lastSkipTime = at;
            return { ran: false, seq: this.seq, reason: "busy" };
        }
        this.busy = true;
        this.seq += 1;
        return { ran: true, seq: this.seq };
    }

    /** 宣布这一拍跑完了（成功、失败都必须调 —— 失败不是「还在跑」）。 */
    end(): void {
        this.busy = false;
    }

    /** 此刻是否正有一拍在跑。 */
    isBusy(): boolean {
        return this.busy;
    }

    /** 最后一次跳拍的时刻（ms）；从没跳过 = null。 */
    lastSkipAt(): number | null {
        return this.lastSkipTime;
    }

    stats(): TickStats {
        return { seq: this.seq, skipped: this.skipped };
    }

    /** 测试专用：清零。生产调用会让序号回退，等于「假装时间倒流」。 */
    reset(): void {
        this.seq = 0;
        this.skipped = 0;
        this.busy = false;
        this.lastSkipTime = null;
    }
}
