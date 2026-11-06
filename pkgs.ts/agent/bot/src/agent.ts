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
    stepDeltaOf,
    treeOfGlobals,
    valueHashes,
    type ContextPath,
    type ContextProvider,
    type DeltaSnapshot,
} from '@diy-agent/context';
import {
    createSession,
    type AgentSession,
    type ChatMessage,
    type ChatOptions,
    type Compactor,
    type LlmPort,
    type SessionDelta,
    type SessionRequest,
    type SessionStore,
} from '@diy-agent/session';

/** 一轮的结果（`send` 用） */
export interface BotAgentResult {
    /** 助手这一轮说出来的全部正文 */
    readonly text: string;
    /** **这一次真发的请求**（system + 交给 LLM 的 messages 快照）；没发成 = null */
    readonly request: SessionRequest | null;
    /** 逐条 delta（调试 / 断言工具调用用） */
    readonly deltas: readonly SessionDelta[];
    /**
     * 这一轮发完之后的新快照 —— 交给调用方保存（存哪、存不存，Agent 不决定）。
     *
     * 下一轮把它作为 `initialSnapshot` 传回来即可接着算增量；传 `null` = 下一轮多发一次全量。
     */
    readonly snapshot: DeltaSnapshot | null;
}

export interface BotAgentOptions {
    readonly id: string;
    readonly llm: LlmPort;
    readonly store: SessionStore;
    readonly model: string;
    /** 上下文树的提供器（bot 用 diy / cwd / chain / skills 四个就够） */
    readonly providers: readonly ContextProvider[];
    /** system 名单（哪些 path 进 system、哪些进 runtime）—— **必填**，不让调用方猜缺省是哪套 */
    readonly systemPlaces: readonly ContextPath[];
    /**
     * bot 的**行为指令**（人写的，不是从变量树算的）。拼在 system 最前面。
     *
     * 为什么单独一个参数而不是塞成一个 provider：它不是「变量树的一个节点」——
     * 变量树描述的是**环境**（在哪、什么规则、什么任务），behavior 是**人格**。
     * 混进去会让 help 里多出一个模型不该"装载/卸载"的节。
     */
    readonly instructions: string;
    /**
     * 起始快照：**第一轮之前**模型已经"看过"的那棵树（`null` = 没有历史）。
     *
     * 为什么是初值而不是 `load()`/`save()` 一对（2026-11-05 用户裁）：
     *   「发送的消息会有 session store 保存 …… 外部是进行重放形成 DeltaSnapshot 给 load 用，
     *     还是单独存一个特殊的临时值，**不应该由 save 决定**」。
     *
     * 所以 Agent **不拥有**这份状态：
     *   · 怎么存（内存变量 / turns.jsonl 重放 / 别的形式）是外部的事
     *   · Agent 只在**一轮之内**推进它，结束时通过 `BotAgentResult.snapshot` 交回
     *   · 下一轮（或重启后）由外部把它作为 `initialSnapshot` 再传进来
     */
    readonly initialSnapshot: DeltaSnapshot | null;
    /** 已有的历史（首轮为空）；给了就作为会话起点 */
    readonly initialMessages?: readonly ChatMessage[];
    /** 每轮跑之前用（压缩）；缺省不压（`Compactor` 是 session 包定义的那一个形状） */
    readonly compact?: Compactor;
}

/**
 * 每轮可变的调用参数 —— 就是 `ChatOptions` 去掉 `userPrefix`。
 *
 * 为什么去掉：`userPrefix` 由 agent 自己算（跨轮增量），调用方给会导致两处各算一份。
 * 其余（tools / maxSteps / maxOutputTokens / providerOptions）原样透传给 session。
 */
export type BotAgentTurnOptions = Omit<ChatOptions, 'userPrefix'>;

export interface BotAgent {
    /**
     * 底下的会话（**暴露**：宿主还要用它的 messages / usage / append / cancel）。
     *
     * 为什么不做一层薄包装把这些转发一遍：那些方法的语义与 `AgentSession` 完全一致，
     * 转一层只会让调用方在两套 API 之间来回对照。
     */
    readonly session: AgentSession;
    /** 生产：逐条吐 delta */
    stream(text: string, turnOptions?: BotAgentTurnOptions): AsyncGenerator<SessionDelta>;
    /** 测试 / 一次性调用：**吃完同一条流**，返回聚合 + 这次真发的请求 */
    send(text: string, turnOptions?: BotAgentTurnOptions): Promise<BotAgentResult>;
}

/**
 * 组装一次 system 文本。
 *
 * 单独抽出来是为了让「system 长什么样」可以在不建 session 的情况下断言
 * （测试里经常只需要验这一段，不想为此跑一轮 LLM）。
 */
export function systemOf(opts: Pick<BotAgentOptions, 'providers' | 'systemPlaces' | 'instructions'>): string {
    const globals = assembleFromProviders(opts.providers);
    const helps = helpsOf(opts.providers);
    const delivery = buildDelivery(globals, opts.systemPlaces, helps);
    return [opts.instructions.trim(), delivery.system.text].filter((s) => s !== '').join('\n\n');
}

export function createBotAgent(opts: BotAgentOptions): BotAgent {
    const session: AgentSession = createSession({
        id: opts.id,
        llm: opts.llm,
        store: opts.store,
        ...(opts.initialMessages === undefined ? {} : { initialMessages: opts.initialMessages }),
        ...(opts.compact === undefined ? {} : { compact: opts.compact }),
        // system 在**建会话时**算一次就固定下来（段首快照语义，见文件头）。
        // ⚠ 只在**空会话**时传：老会话的历史里已经有一条 system，再传会追加第二条。
        ...((opts.initialMessages ?? []).length > 0 ? {} : { system: systemOf(opts) }),
        model: opts.model,
    });

    /** 上一次给模型看过的树（跨轮增量的基准）；**初值由调用方给**，Agent 只在一轮之内推进 */
    let prevSnap: DeltaSnapshot | null = opts.initialSnapshot;

    async function* run(text: string, turnOptions?: BotAgentTurnOptions): AsyncGenerator<SessionDelta> {
        // 每轮算全量树（值便宜），然后只把**变化的部分**作为 user 前缀发出去 ——
        // 已发出的历史一条不动，这是 `agent-prefix` 测试守的判据。
        const globals = assembleFromProviders(opts.providers);
        const tree = treeOfGlobals(globals);
        const snap: DeltaSnapshot = { tree, valueHashes: valueHashes(tree) };
        const delta = prevSnap === null ? null : stepDeltaOf(prevSnap, snap);
        const userPrefix = delta === null || delta.text === '' ? undefined : delta.text;
        yield* session.send(text, {
            ...turnOptions,
            ...(userPrefix === undefined ? {} : { userPrefix }),
        });
        // 游标前移**在发完之后**：发送失败也要前移吗？—— 是。失败的这一轮已经落进 store
        // （user 消息已 append），下一次看到的树就是这一次的树。
        prevSnap = snap;
    }

    return {
        session,
        stream: run,
        async send(text, turnOptions) {
            const deltas: SessionDelta[] = [];
            for await (const delta of run(text, turnOptions)) deltas.push(delta);
            const combined = deltas
                .filter((d): d is { type: 'text'; text: string } => d.type === 'text')
                .map((d) => d.text)
                .join('');
            return { text: combined, request: session.lastRequest, deltas, snapshot: prevSnap };
        },
    };
}
