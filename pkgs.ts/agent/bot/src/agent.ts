// agent.ts —— 把「上下文树 → system 文本 → 一轮 LLM 调用」收成一个对象。
//
// ── 为什么要这层（2026-11-05 用户裁）──
//   「上下文树 / 压缩的开发过程中，算法都商量好了、需求都说清楚了，但实际检查 raw request
//    发现提交错了 …… 设计上缺少一个总体的验证点，都是零散的算法。」
//
// 散着用（assembleFromProviders → buildDelivery → session.send）时，**没有任何地方**能回答
// 「这一次到底发出去了什么」。而这层把三件事收在一处：
//   ① system 从 providers 算出来（不是外部传的常量）
//   ② 真发那一刻的 messages 快照被记下（`result.request`）
//   ③ 于是「前缀不变」可以断言：`r2.request.messages.slice(0, n) === r1.request.messages`
//
// ── 边界（用户 2026-11-05：「Agent 类只给新 bot 使用，老 app 只用零散元件」）──
// 只服务 bot：没有 turn 边界、没有预检重算、没有 diy-app 那五处注入。
// diy-app 继续用它自己的 local-agent，不动。
//
// ── system 只在**建 session 时**算一次 ──
// 这是缓存的前提（段首快照）：变量树再怎么变，已发出的 system 不重写；变化走 user 增量。
// 与 `apps/diy-app/shared/context/segment-snapshot.ts` 同一条铁律，只是 bot 这边更简单
// （还没有跨轮增量，先不引入）。

import {
    assembleFromProviders,
    buildDelivery,
    helpsOf,
    type ContextPath,
    type ContextProvider,
} from '@diy-agent/context';
import { createSession, type AgentSession, type ChatMessage, type LlmPort, type SessionDelta, type SessionRequest, type SessionStore } from '@diy-agent/session';

/** 一轮的结果（`send` 用） */
export interface BotAgentResult {
    /** 助手这一轮说出来的全部正文 */
    readonly text: string;
    /** **这一次真发的请求**（system + 交给 LLM 的 messages 快照）；没发成 = null */
    readonly request: SessionRequest | null;
    /** 逐条 delta（调试 / 断言工具调用用） */
    readonly deltas: readonly SessionDelta[];
}

export interface BotAgentOptions {
    readonly id: string;
    readonly llm: LlmPort;
    readonly store: SessionStore;
    readonly model: string;
    /** 上下文树的提供器（bot 用 diy / cwd / chain / skills 四个就够） */
    readonly providers: readonly ContextProvider[];
    /** system 名单（哪些 path 进 system、哪些进 runtime）；缺省用 context 包的推荐名单 */
    readonly systemPlaces?: readonly ContextPath[];
    /** 已有的历史（首轮为空）；给了就作为会话起点 */
    readonly initialMessages?: readonly ChatMessage[];
    /** 每轮跑之前用（压缩）；缺省不压 */
    readonly compact?: (history: readonly ChatMessage[]) => Promise<readonly ChatMessage[]>;
}

export interface BotAgent {
    /** 生产：逐条吐 delta */
    stream(text: string): AsyncGenerator<SessionDelta>;
    /** 测试 / 一次性调用：**吃完同一条流**，返回聚合 + 这次真发的请求 */
    send(text: string): Promise<BotAgentResult>;
}

/**
 * 组装一次 system 文本。
 *
 * 单独抽出来是为了让「system 长什么样」可以在不建 session 的情况下断言
 * （测试里经常只需要验这一段，不想为此跑一轮 LLM）。
 */
export function systemOf(opts: Pick<BotAgentOptions, 'providers' | 'systemPlaces'>): string {
    const globals = assembleFromProviders(opts.providers);
    const helps = helpsOf(opts.providers);
    const delivery = buildDelivery(globals, opts.systemPlaces, helps);
    return delivery.system.text;
}

export function createBotAgent(opts: BotAgentOptions): BotAgent {
    const session: AgentSession = createSession({
        id: opts.id,
        llm: opts.llm,
        store: opts.store,
        ...(opts.initialMessages === undefined ? {} : { initialMessages: opts.initialMessages }),
        ...(opts.compact === undefined ? {} : { compact: opts.compact }),
        // system 在**建会话时**算一次就固定下来（段首快照语义，见文件头）
        system: systemOf(opts),
        model: opts.model,
    });

    async function* run(text: string): AsyncGenerator<SessionDelta> {
        yield* session.send(text);
    }

    return {
        stream: run,
        async send(text) {
            const deltas: SessionDelta[] = [];
            for await (const delta of run(text)) deltas.push(delta);
            const combined = deltas
                .filter((d): d is { type: 'text'; text: string } => d.type === 'text')
                .map((d) => d.text)
                .join('');
            return { text: combined, request: session.lastRequest, deltas };
        },
    };
}
