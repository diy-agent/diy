// src/main/services/cache-hint.ts
// 🎯 冷缓存提示的**装配层**（##477）：把真发的首步事实喂给判据，产出「顶栏一行提示」+ 落盘边界。
//
// 分工（与 env-watch / model-notice 同构）：
//   · 判据 = shared/cache-hint.ts（纯函数：P90、只降不升、max(safePoint, failPoint)）
//   · 落盘 = main/core/cache-hint-store.ts（$DIY_HOME/cache-hint.yaml）
//   本文件只管：算 gap → 问判据 → 更新统计 → 广播/撤销那一行提示。
//
// 为什么提示只有**一行**（用户硬要求）：多条并存时逐条弹会刷屏，而这一行的动作
// （换个模型 / 先压缩）对每个渠道都一样；新的一条**替换**旧的，不叠加、不弹窗。
//
// 谁在什么时候调用（唯一调用点 = local-agent 的 runTurn）：
//   · 每轮**首步请求发出前** `noteRequest(...)` —— 只有这里拿得到"本会话距上次多久"（##492）
//   · 该首步的 usage 到手后 `noteFirstStepResult(...)` —— 命中率是这一步的硬事实
//   · 首步之外的步一律不参与（它们在轮内挨着发，gap 是秒级噪声，会把 P90 拖歪）

import { AsyncQueue, withCleanup } from "./async-queue";
import { diyHome } from "../core/state";
import { loadCacheHintStore, saveCacheHintStore, type CacheHintStore } from "../core/cache-hint-store";
import { findModel } from "../../shared/models";
import {
    bumpTodayCount,
    cacheHintText,
    channelKey,
    classifyFirstStep,
    decideHint,
    emptyChannelStats,
    firstStepHitRate,
    localDateKey,
    safePointOf,
    sessionKeyOf,
    splitChannel,
    SAFE_POINT_WINDOW,
    recordFailureGap,
    withSuccessGap,
    type CacheChannelView,
    type CacheHint,
    type CacheHintEvent,
    type ChannelStats,
    type HintDecision,
} from "../../shared/cache-hint";
import { localISOString } from "@diy-agent/time";

/** 一次首步请求的输入（调用点已解析好渠道；本服务不碰 persona / provider 配置） */
export interface NoteRequestInput {
    provider: string;
    model: string;
    taskUri: string;
    persona?: string;
    /** 注入时钟（单测用） */
    now?: number;
}

/** noteRequest 的回报：调用点据此在本步 usage 到手后回填结果 */
export interface NoteRequestResult {
    channel: string;
    /** 本**会话**距上次首步请求的间隔；null = 本会话第一次（算不出，不参与统计） */
    gapMs: number | null;
    /** 命中的边界（null = 不提示） */
    decision: HintDecision | null;
    /** 本次产出的提示（null = 不提示，且已撤掉旧的一行） */
    hint: CacheHint | null;
}

class CacheHintService {
    /** 懒加载的 store（进程内一份；写盘后同步更新） */
    private store: CacheHintStore | null = null;
    /** 当前那一行提示（null = bar 不显示） */
    private current: CacheHint | null = null;
    private queues = new Set<AsyncQueue<CacheHintEvent>>();
    private seq = 0;

    private ensure(now = new Date()): CacheHintStore {
        if (!this.store) this.store = loadCacheHintStore(diyHome(), now);
        return this.store;
    }

    /** 一个渠道的统计（必返回；没有历史就给缺省，调用方不必判空） */
    stats(channel: string, now = new Date()): ChannelStats {
        return this.ensure(now).channels[channel] ?? emptyChannelStats(localISOString(now));
    }

    /** 一个会话的上次请求时刻（null = 没发过 / 没给会话） */
    lastRequestAtOf(session: string | null, now = new Date()): number | null {
        if (!session) return null;
        return this.ensure(now).sessions[session]?.lastRequestAt ?? null;
    }

    /**
     * 首步请求发出前：算 gap、问判据、更新 lastRequestAt、必要时亮/撤那一行。
     *
     * gap 读的是**本会话**的 lastRequestAt（##492）：别的任务刚发过请求，与本会话的缓存
     * 毫无关系（前缀不重叠）；而边界仍按**渠道**算。两个维度分开取，才不互相带歪。
     */
    noteRequest(input: NoteRequestInput): NoteRequestResult {
        const now = input.now ?? Date.now();
        const nowDate = new Date(now);
        const nowIso = localISOString(nowDate);
        const channel = channelKey(input.provider, input.model);
        const session = sessionKeyOf(input.taskUri);
        const store = this.ensure(nowDate);
        const prev = store.channels[channel] ?? emptyChannelStats(nowIso);

        const prevAt = session ? (store.sessions[session]?.lastRequestAt ?? null) : null;
        const gapMs = prevAt !== null && now > prevAt ? now - prevAt : null;
        const safePointMs = safePointOf(prev.samples);
        const decision = decideHint({ gapMs, safePointMs, failPointMs: prev.failPoint });

        let hint: CacheHint | null = null;
        if (decision) {
            const hints = bumpTodayCount(prev.hints, localDateKey(nowDate));
            hint = {
                id: `ch-${now}-${++this.seq}`,
                ts: nowIso,
                channel,
                provider: input.provider,
                model: input.model,
                gapMs: gapMs!,
                safePointMs,
                failPointMs: prev.failPoint,
                thresholdMs: decision.thresholdMs,
                thresholdKind: decision.thresholdKind,
                // 本次已计入，所以展示值就是累计后的数
                todayCount: hints.count,
                taskUri: input.taskUri,
                ...(input.persona ? { persona: input.persona } : {}),
            };
            store.channels[channel] = { ...prev, hints, updatedAt: nowIso };
            if (session) store.sessions[session] = { lastRequestAt: now };
            this.show(hint);
        } else {
            store.channels[channel] = { ...prev, updatedAt: nowIso };
            if (session) store.sessions[session] = { lastRequestAt: now };
            // 只撤**本渠道**那条：别的渠道的提示不该被这次请求顺手擦掉（一行也得说对是谁）
            if (this.current?.channel === channel) this.clear();
        }
        this.persist();
        return { channel, gapMs, decision, hint };
    }

    /**
     * 首步 usage 到手后回填：
     *   · 真命中（>0.9）→ gap 进 safePoint 窗口
     *   · ≈0（<0.05）→ failPoint 只降不升（**但安全区内的失败忽略**，见 recordFailureGap）
     *   · 灰区（0.05~0.9）→ 两种都不记（多半是前缀变了 / 上游抖动，不是时间因素）
     *
     * 「失败边界真的被收紧」那一刻**也亮一次提示**：这正是用户刚按全价付完的时刻，
     * 也是"缓存已冷"这个事实第一次有证据的时刻（此前 failPoint=+∞ ⇒ 按定稿规则不提示）。
     * 同一次请求如果在发出前已经亮过（`hinted`），这里不再弹第二条 —— 一行就够。
     */
    noteFirstStepResult(input: {
        channel: string;
        gapMs: number | null;
        inputTokens: number;
        cacheRead: number;
        taskUri?: string;
        persona?: string;
        /** 这次请求在发出前是否已经亮过提示（同一次请求不重复弹） */
        hinted?: boolean;
        now?: number;
    }): "success" | "miss" | null {
        if (input.gapMs === null) return null;
        const verdict = classifyFirstStep(firstStepHitRate(input.inputTokens, input.cacheRead));
        const nowDate = new Date(input.now ?? Date.now());
        const nowIso = localISOString(nowDate);
        const store = this.ensure(nowDate);
        const prev = store.channels[input.channel] ?? emptyChannelStats(nowIso);
        if (verdict === "success") {
            const samples = withSuccessGap(prev.samples, input.gapMs);
            store.channels[input.channel] = {
                ...prev,
                samples,
                safePoint: safePointOf(samples),
                updatedAt: nowIso,
            };
            this.persist();
        } else if (verdict === "miss") {
            const safePointMs = safePointOf(prev.samples);
            const failPoint = recordFailureGap(safePointMs, prev.failPoint, input.gapMs);
            const learned = failPoint !== prev.failPoint;
            if (!learned) {
                // 安全区内的失败：一条都不动（也不出声）—— 否则提示过多
                return verdict;
            }
            let hints = prev.hints;
            if (!input.hinted) {
                hints = bumpTodayCount(prev.hints, localDateKey(nowDate));
                const { provider, model } = splitChannel(input.channel);
                this.show({
                    id: `ch-${nowDate.getTime()}-${++this.seq}`,
                    ts: nowIso,
                    channel: input.channel,
                    provider,
                    model,
                    gapMs: input.gapMs,
                    safePointMs,
                    failPointMs: failPoint,
                    thresholdMs: failPoint!,
                    thresholdKind: "fail",
                    todayCount: hints.count,
                    taskUri: input.taskUri ?? "",
                    ...(input.persona ? { persona: input.persona } : {}),
                });
            }
            store.channels[input.channel] = { ...prev, failPoint, hints, updatedAt: nowIso };
            this.persist();
        }
        return verdict;
    }

    /**
     * **探针**（仅非生产）：造一次「首步请求 + 可选结果」而不真发。
     *
     * 为什么必须有：真验证这六条契约只能靠跑真模型几百次（不可复现、还要钱）；而判据要的
     * 事实只有两件 —— 间隔与首步命中率。探针走的是与真发**同一条** noteRequest /
     * noteFirstStepResult，差别只在事实来源（与 `diy env simulate` 同一取舍）。
     *
     * `repeat`：N 次同 gap 的请求（造 safePoint 的 P90 用；一次 CLI 就能造满 100 个样本）。
     */
    simulate(input: {
        provider: string;
        model: string;
        gapMs: number;
        hit?: "success" | "miss" | "none";
        repeat?: number;
        taskUri?: string;
    }): CacheChannelView & { hint: CacheHint | null } {
        const times = Math.max(1, Math.min(SAFE_POINT_WINDOW + 20, Math.floor(input.repeat ?? 1)));
        const now = Date.now();
        const nowIso = localISOString(new Date(now));
        const channel = channelKey(input.provider, input.model);
        // 探针自己也占一条会话（缺省 probe）：lastRequestAt 现在按会话记（##492）
        const session = sessionKeyOf(input.taskUri) ?? "probe";
        let lastHint: CacheHint | null = null;
        for (let i = 0; i < times; i++) {
            // 把「本会话上次请求」拨到 now - gap：noteRequest 算出来的 gap 就是 assert 的那个数
            const store = this.ensure(new Date(now));
            store.sessions[session] = { lastRequestAt: now - input.gapMs };
            const r = this.noteRequest({
                provider: input.provider,
                model: input.model,
                taskUri: session,
                now,
            });
            lastHint = r.hint;
            if (input.hit && input.hit !== "none") {
                this.noteFirstStepResult({
                    channel: r.channel,
                    gapMs: r.gapMs,
                    inputTokens: 1000,
                    cacheRead: input.hit === "success" ? 950 : 0,
                    taskUri: session,
                    hinted: r.hint !== null,
                    now,
                });
                // 失败被记录的那一刻也会亮一条（"刚付完全价"）—— 那也是本次请求的结论
                const cur = this.currentOf();
                if (cur && cur.channel === channel) lastHint = cur;
            }
        }
        return { ...this.viewOfChannel(input.provider, input.model, new Date(now), session), hint: lastHint };
    }

    /**
     * 「缓存时效柱」的数据；`modelRef` 是对话事实里的 `account@provider/model`。
     * `taskUri` = 会话（缺省 null ⇒ `lastRequestAt` 为 null，柱上显示「—」）。
     */
    viewOf(modelRef: string | null | undefined, taskUri?: string | null, now = new Date()): CacheChannelView | null {
        if (!modelRef) return null;
        const rm = findModel(modelRef);
        if (!rm) return null;
        return this.viewOfChannel(rm.provider, rm.id, now, taskUri);
    }

    /** 已知 provider/model 的视图（探针与 viewOf 共用，别在两边各拼一遍） */
    viewOfChannel(provider: string, model: string, now = new Date(), taskUri?: string | null): CacheChannelView {
        const channel = channelKey(provider, model);
        const s = this.stats(channel, now);
        const session = sessionKeyOf(taskUri);
        return {
            channel,
            provider,
            model,
            // 边界是**渠道**的（不变）；「距上次请求」是**会话**的（##492）
            safePointMs: safePointOf(s.samples),
            failPointMs: s.failPoint,
            lastRequestAt: this.lastRequestAtOf(session, now),
            session,
            samples: s.samples.length,
            hintsToday: s.hints.date === localDateKey(now) ? s.hints.count : 0,
        };
    }

    /** 当前那一行（CLI / 测试 / 订阅回放用） */
    currentOf(): CacheHint | null {
        return this.current;
    }

    /**
     * 用户点 ✕：撤掉当前这一行。**不静音**：同一条提示不会自己再出现（它描述的是已发生的那次
     * 请求），下次越界是一条新事实、该亮还是要亮。
     */
    dismiss(id?: string): void {
        if (!this.current) return;
        if (id !== undefined && this.current.id !== id) return;
        this.clear();
    }

    /** 订阅：先回放当前（页面重载后 bar 能自己回来），再收增量 */
    subscribe(signal?: AbortSignal): AsyncIterable<CacheHintEvent> {
        const q = new AsyncQueue<CacheHintEvent>();
        if (this.current) q.push({ kind: "show", data: this.current });
        this.queues.add(q);
        return withCleanup(q, () => this.queues.delete(q), signal);
    }

    /** 测试用：清空内存态（store 从盘重读） */
    reset(): void {
        this.store = null;
        this.current = null;
        this.queues.clear();
    }

    /** bar 文案（CLI 人读 / 测试断言同一个出口） */
    textOf(h: CacheHint): string {
        return cacheHintText(h);
    }

    private show(hint: CacheHint): void {
        this.current = hint;
        for (const q of this.queues) q.push({ kind: "show", data: hint });
    }

    private clear(): void {
        const cur = this.current;
        if (!cur) return;
        this.current = null;
        for (const q of this.queues) q.push({ kind: "clear", data: { id: cur.id } });
    }

    private persist(): void {
        const store = this.store;
        if (!store) return;
        try {
            saveCacheHintStore(diyHome(), store);
        } catch (e) {
            // 落盘失败不阻断对话：边界只是"下次启动的起点"，内存里这份照常可用。
            console.warn("[cache-hint] 写 store 失败（本次仍按内存值判断）:", e);
        }
    }
}

export const cacheHint = new CacheHintService();

/** 渠道键的展示拆解（CLI 用；避免各调用点各 split 一遍） */
export function providerModelOf(channel: string): { provider: string; model: string } {
    return splitChannel(channel);
}
