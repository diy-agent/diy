// src/main/core/restart-gate.ts
// 🎯 热重启让位：watch 重建 main 后要**替换实例**，而本地 agent 的轮次就活在这个进程里。
//
// 病根（##404 实测）：`scripts/electron-dev.mts` 每次重建都 SIGTERM + 5s 后 SIGKILL，
// 而一个「正在改 `src/**` 的 agent」每改一次就触发一次重建 ⇒ **它把自己的轮次杀掉一次**。
// lab 实测一天 5 条 `agent/app-restart`「本轮未完成（进程重启）」，任务永远做不完。
//
// 判据因此简单到一句话：**有轮次在跑就不退，等它们跑完再退**。
//   · 空闲时行为与改动前完全一致（零延迟）—— 这里不引入任何常驻开销
//   · 只对「换」（热重启）让位；「停」（SIGTERM/SIGINT，用户 Ctrl-C）仍然立刻退，
//     否则用户停不掉实例
//   · 让位有上限（缺省 30 分钟）：挂死的轮次不许把热重启永久拖住，超时照退并留痕
//
// 纯逻辑、依赖全注入 ⇒ 可单测（生产接线见 `services/crash-reporting.ts` 的 SIGUSR2）。

/** 让位时读「此刻在跑的轮次」（生产 = `runtime-context.activeTurnList()`，纯内存读） */
export interface RestartGateDeps {
    activeTurns: () => readonly { taskUri: string }[];
    /** 真正退出（生产 = 写 `app-exit.jsonl` 留痕 + `app.quit()`） */
    quit: (why: string) => void;
    log?: (line: string) => void;
    /** 让位上限（毫秒），缺省 30 分钟 */
    maxWaitMs?: number;
    /** 轮询间隔（毫秒），缺省 1s */
    pollMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    now?: () => number;
}

export type GateVerdict =
    | { deferred: false }
    /** `waiting` = 让位时在跑的任务（人读：日志里直接说是谁把它拖住了） */
    | { deferred: true; waiting: readonly string[] };

const DEFAULT_MAX_WAIT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 1000;

/**
 * 有轮次在跑 ⇒ 延后退出，等它们结束（或超时）再退。
 *
 * 返回 `deferred: false` 表示「此刻空闲，调用方照常立刻退」—— 调用方**必须**按它决定，
 * 别自己再判一次（两份判据会漂：一处判空闲一处判在跑，症状是随机地砍轮次）。
 */
export function deferQuitUntilIdle(deps: RestartGateDeps): GateVerdict {
    const now = deps.now ?? (() => Date.now());
    const log = deps.log ?? (() => {});
    const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

    const waiting = deps.activeTurns().map((t) => t.taskUri);
    if (waiting.length === 0) return { deferred: false };

    const deadline = now() + maxWaitMs;
    let settled = false;

    const tick = (): void => {
        if (settled) return;
        const still = deps.activeTurns().map((t) => t.taskUri);
        if (still.length === 0) {
            settled = true;
            deps.quit("轮次已结束");
            return;
        }
        if (now() >= deadline) {
            settled = true;
            // 超时必须留痕：否则下一轮读日志只知道「被重启打断」，不知道是让位超时
            log(`[restart-gate] 让位超时（${Math.round(maxWaitMs / 1000)}s），照退：在跑 ${still.join(", ")}`);
            deps.quit(`让位超时，仍有 ${still.length} 轮在跑`);
            return;
        }
        setTimer(tick, pollMs);
    };

    log(
        `[restart-gate] 有 ${waiting.length} 轮在跑，延后退出（最多 ${Math.round(maxWaitMs / 1000)}s）：${waiting.join(", ")}`,
    );
    tick();
    return { deferred: true, waiting };
}
