// src/main/services/model-notice.ts
// 🎯 「模型不可用」通知中心 —— 真发请求因**模型不可用**失败时，把这条事实从会话流里
//    **提出来**，交给界面顶栏 bar（##369 ①）。
//
// 为什么需要独立一处：失败本来只写进会话块（用户不看会话就不知道实验其实没跑成）。
// 顶栏 bar 要的是一份**进程级**的当前事实，且**与具体任务/订阅无关** —— 所以这里既不是
// 任务日志的一部分，也不该挂在某个会话的 op 流上。
//
// 数据定性 = **cache**（`rule.core-log` 同一原则）：进程内存 ring，重启即空 —— 它描述的是
// 「此刻有什么坏了」，不是历史账；要追溯去看 `~/.diy/log/network/*.jsonl` 与会话流。
//
// 判据不在本文件：**唯一判据**是 shared/model-unavailable.ts 的纯函数（表驱动单测在
// tests/core/model-unavailable.test.ts）。本文件只做三件事：从异常取事实 → 组装通知 → 广播。

import { AsyncQueue, withCleanup } from "./async-queue";
import { classifyModelUnavailable, probeModelError, type ModelUnavailableNotice } from "../../shared/model-unavailable";

/** ring 上限：bar 只显示最新一条，留一小段历史够 CLI 排查即可 */
const MAX_NOTICES = 20;

/** 通知的触发上下文（组装通知时由调用点补的事实） */
export interface ModelNoticeContext {
    taskUri: string;
    personaId: string;
    personaName: string;
    model: string;
}

let seq = 0;

/**
 * 从一次真发失败里组装通知：**命中判据才返回**，否则 null（调用方据此决定要不要报警）。
 *
 * 抽成独立纯装配函数（异常 + 上下文 → 通知 | null），是为了让"哪类错误该亮 bar"这件事
 * 只依赖 shared 判据 —— 调用点（local-agent 的 catch）只负责把事实递进来。
 */
export function noticeFromError(e: unknown, ctx: ModelNoticeContext, now = new Date()): ModelUnavailableNotice | null {
    const probe = probeModelError(e);
    const verdict = classifyModelUnavailable(probe);
    if (!verdict.hit) return null;
    return {
        id: `mu-${now.getTime()}-${++seq}`,
        ts: now.toISOString(),
        kind: verdict.kind,
        reason: verdict.reason,
        upstream: verdict.upstream,
        statusCode: probe.statusCode,
        personaId: ctx.personaId,
        personaName: ctx.personaName,
        model: ctx.model,
        taskUri: ctx.taskUri,
    };
}

/** 本地错误的展示上限（与 upstream 同口径；本地文案一般很短，截断只是兜底） */
const MAX_LOCAL_CHARS = 300;

/**
 * **本地装配期**就确知「模型不可用」时用（模型 id 不在清单里 / 人物还没配模型）。
 *
 * 为什么不复用文案判据：这里的事实由**调用点确知**（main 自己抛的那句话），不需要从
 * 一堆异常里正则猜 —— 判据函数留给"上游回了个东西，要判它算不算模型不可用"的场景。
 * 两类入口都产出同一种通知，bar 因此不必知道自己是被谁触发的。
 */
export function unavailableNoticeFromLocal(message: string, ctx: ModelNoticeContext, now = new Date()): ModelUnavailableNotice {
    return {
        id: `mu-${now.getTime()}-${++seq}`,
        ts: now.toISOString(),
        kind: "unknown-model",
        reason: "本地模型清单里没有这个 id：人物指向的模型可能已下架，或 provider 还没配",
        upstream: message.replace(/\s+/g, " ").trim().slice(0, MAX_LOCAL_CHARS),
        statusCode: null,
        personaId: ctx.personaId,
        personaName: ctx.personaName,
        model: ctx.model,
        taskUri: ctx.taskUri,
    };
}

/**
 * 通知中心：ring + fan-out 订阅。
 *
 * 订阅语义与 file-watcher 一致（多订阅者各拿独立副本），**外加一次回放**：
 * 新订阅者先收到当前未关闭的通知，再收增量 —— 否则"页面重载后 bar 消失"会让
 * 提示形同虚设（用户重开窗口正是最可能错过提示的时刻）。
 */
class ModelNoticeHub {
    private notices: ModelUnavailableNotice[] = [];
    private queues = new Set<AsyncQueue<ModelUnavailableNotice>>();

    /** 记一条通知（ring 满则丢最老的）：落内存 + 广播给所有订阅者 */
    push(n: ModelUnavailableNotice): void {
        this.notices.push(n);
        if (this.notices.length > MAX_NOTICES) this.notices.splice(0, this.notices.length - MAX_NOTICES);
        for (const q of this.queues) q.push(n);
    }

    /** 用户关掉（"我知道了"）—— 从 ring 移除，重连不再回放。不给 id = 全关（bar 的 ✕ 语义） */
    dismiss(id?: string): void {
        if (!id) {
            this.notices = [];
            return;
        }
        this.notices = this.notices.filter((n) => n.id !== id);
    }

    /** 当前未关闭的通知（CLI `diy notice list` / 测试用） */
    list(): ModelUnavailableNotice[] {
        return [...this.notices];
    }

    /** 订阅（serverStream 直接 yield 此 async iterable）：先回放现存，再收增量 */
    subscribe(signal?: AbortSignal): AsyncIterable<ModelUnavailableNotice> {
        const q = new AsyncQueue<ModelUnavailableNotice>();
        for (const n of this.notices) q.push(n); // 回放（含订阅前就存在的那条）
        this.queues.add(q);
        return withCleanup(q, () => this.queues.delete(q), signal);
    }
}

export const modelNoticeHub = new ModelNoticeHub();
