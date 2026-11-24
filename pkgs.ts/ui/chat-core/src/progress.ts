// progress.ts —— 「这一轮还在动吗」的**显示层**（文案 + 自走秒数），两套 surface 共用。
//
// 数据来自 protocol 的 `progress` 事件（服务端已节流：只在事实变了时发）。
// 这里只做三件事：
//   1. 机器码 → 人话（`awaiting`）
//   2. 服务端 `idleMs` + 本地流逝 → 此刻「多久没动」（不每秒一条事件、也不校时钟）
//   3. 分档 → 文案/样式（`quiet` 与改造前完全一致 —— 正常思考不该变成跳动的界面）
//
// **阈值不在这里**：档位（`stage`）是服务端按 entity-runtime 的 ProgressPolicy 算好发来的。
// UI 再拿秒数比一次就是第二份阈值，注定了和真判据漂开。

import type { DeliveryState, ProgressStage } from './types';

/**
 * 一个成员此刻的进展（客户端版：比协议事件多一个 `at` —— 收到时刻，用来自走）。
 *
 * `at` 必须是**客户端**的 `Date.now()`：拿服务端时钟会和本地差出几百毫秒甚至几秒，
 * 而这里只关心「从我收到起又过了多久」。
 */
export interface BotProgress {
    awaiting: string;
    /** 收到事件那一刻的 idle（毫秒，服务端算的） */
    idleMs: number;
    /** 客户端收到时刻 */
    at: number;
    alive: boolean;
    stage: ProgressStage;
}

/** 机器码 → 人话：`model-stream` → 模型响应，`tool:bash` → bash */
export function awaitingText(awaiting: string): string {
    if (awaiting === 'model-stream') return '模型响应';
    if (awaiting === 'compact') return '压缩上下文';
    if (awaiting === 'ask') return '等回答';
    if (awaiting.startsWith('tool:')) return awaiting.slice('tool:'.length);
    return awaiting;
}

/**
 * 进行时短语（`RoomStatusBar` 用）。
 *
 * 为什么不能一律说「正在说话」：跑工具时它没在说话 —— 那句话既不准又让人以为
 * 模型在生成文本（于是卡住时更看不懂）。
 */
export function doingText(awaiting: string): string {
    if (awaiting === 'model-stream') return '正在等模型…';
    if (awaiting === 'compact') return '正在压缩上下文…';
    if (awaiting === 'ask') return '正在等回答…';
    if (awaiting.startsWith('tool:')) return `正在调用 ${awaiting.slice('tool:'.length)}…`;
    return `正在${awaiting}…`;
}

/** 毫秒 → `12s` / `1m03s` / `12m`（读起来和秒数一样直白，长跑时不刷屏） */
export function elapsedText(ms: number): string {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
    return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

/** 自走：从收到那条事件的时刻起，再过了多久没动 */
export function idleNowOf(progress: BotProgress, now: number = Date.now()): number {
    return Math.max(0, progress.idleMs + (now - progress.at));
}

/**
 * 一行状态文案。
 *
 * 三档的用意（见计划 5.2）：
 *   · `quiet`   与改造前完全一致（`执行中 12s`）—— 正常思考不该变成跳动的界面
 *   · `slow`    `等待模型响应 · 已 1m03s`：把"秒数"从"等了多久"换成"多久没动"
 *   · `stalled` `失联 2m05s`：这一轮确实卡住了（服务端 120s 就会收，这只是最后半分钟的样子）
 *   · `alive`   `bash 运行中 · 有进展 3s 前`：有活的证据就永不报警（12 分钟的构建也是健康的）
 */
export function progressLineOf(progress: BotProgress, now: number = Date.now()): string {
    const idle = idleNowOf(progress, now);
    const what = awaitingText(progress.awaiting);
    if (progress.alive) return `${what} 运行中 · 有进展 ${elapsedText(idle)}前`;
    if (progress.stage === 'stalled') return `失联 ${elapsedText(idle)}（等${what}）`;
    if (progress.stage === 'slow') return `等待${what} · 已 ${elapsedText(idle)}`;
    return `执行中 ${elapsedText(idle)}`;
}

// ─── 「被等着的两件事」：提问、投递 ───────────────────────────────
//
// 上面几行管「它在跑、跑得怎么样」。下面两件管反向的静默：**它什么都没在做，但有东西
// 正等着你**。这两件事在 2026-11-24 的现场（room 01a2091d…）里同时成立、同时没人看见：
// 提问挂着 27 分钟没人答，你 13:34 发的那条消息 `delivering` 到 14:00 也没落地，
// 而界面上一个字都没有 —— 因为「在跑」的信号全没了（speaking=[]），看着就是死了。

/** 待答提问等够了多久才值得在状态栏上说话（刚发出那一秒说「已等 1s」是噪音） */
export const WAIT_QUIET_MS = 3_000;

/**
 * 待答一行的时长短语：`已等 27m`；`at` 缺失或刚发出几秒时给空串（宁可不显示，也别显示负数）。
 *
 * `at` 是**服务端**的提问时刻（`AskRequest.at`）：刷新页面后本地计时器没了，但那句话该说
 * 「这件事已经等了 27 分钟」—— 那是房间的事实，不是这次会话的。
 */
export function waitTextOf(at: number | undefined, now: number = Date.now(), quietMs: number = WAIT_QUIET_MS): string {
    if (at === undefined || !Number.isFinite(at)) return '';
    const waited = Math.max(0, now - at);
    return waited < quietMs ? '' : `已等 ${elapsedText(waited)}`;
}

/**
 * 一条消息投出去了、却没人证明「它在动」多久才值得说话。
 *
 * 15s 的理由：正常一轮从投递到开跑是毫秒级（runtime 拿到就起）；15 秒还没动静，要么前面
 * 真排着队，要么就是丢了。比这短的等待说出来只会变成噪音。
 */
export const DELIVERY_QUIET_MS = 15_000;

/**
 * 投递卡住时的那句话；`undefined` = 别说（一切正常）。
 *
 * 为什么必须和 `live` 一起判，而不是见到 delivering 就显示：正常情况下 `queued/delivering`
 * 与「这个 bot 正在跑」是同一段时间的两面，那时界面上已经有运行指示器 —— 再标一句
 * 「发送中」= 同一件事说两遍，用户反而以为消息没出去。
 *
 * 需要它的场景是两者**脱钩**：投递还挂着，但房间里没有任何内容在流（进程重启 / 队列丢了 /
 * 卡在一张没答的提问上）。那时界面上什么信号都没有，用户只看到「发了，没人理」。
 */
export function deliveryNoteOf(input: {
    state: DeliveryState;
    /** 服务端最后一次更新这条投递的时刻（epoch ms） */
    updatedAt: number;
    /** 这个 bot 现在是否在跑（speaking 或 progress 里有它都算） */
    live: boolean;
    now?: number;
    quietMs?: number;
}): string | undefined {
    const { state, updatedAt, live } = input;
    if (live) return undefined;
    if (state !== 'queued' && state !== 'delivering') return undefined;
    const waited = Math.max(0, (input.now ?? Date.now()) - updatedAt);
    if (waited < (input.quietMs ?? DELIVERY_QUIET_MS)) return undefined;
    return state === 'queued' ? `排队 ${elapsedText(waited)}` : `未开跑 ${elapsedText(waited)}`;
}
