// agent.ts —— 一次 bot 运行：streamText → AgentEvent（文本 / 推理 / 工具 / 结束）。
//
// 除了"给 UI 看的事件流"，这里还负责把**这一轮真正喂进模型的完整消息**回传给调用方
// （assistant 带 tool call / tool result / reasoning 都在里面），session 用它维护自己的原生对话。

import {
    stepCountIs,
    streamText,
    type LanguageModelUsage,
    tool,
    type Experimental_Steering,
    type LanguageModel,
    type ModelMessage,
    type ToolSet,
} from 'ai';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { z } from 'zod';

import { friendlyError, isContextOverflow } from './errors';
import { estimateMessagesTokens, guardMessages } from './context-guard';
import { scrubMedia } from './media-scrub';
import { maxOutputTokensOf, modelOf } from './providers';
import { StallWatchdog, stallMessage, stallTimeoutsFromEnv, type StallInfo } from './stall-watchdog';
import type { AgentEvent, Bot } from './types';

/**
 * 业务包的日志只走 OTel **接口**（##482：默认 noop，装配层设了 provider 才落地）。
 * 这里唯一要说的事就是「SDK 把错误接住后我们怎么记」。
 */
const agentLog = logs.getLogger('entity-runtime:agent');

export interface RunOptions {
    bot: Bot;
    modelKey: string;
    /**
     * 每步读一次当前模型键（缺省 = 用 `modelKey` 的固定值）。
     * 给 session 用：用户切模型后，**当前这一轮的下一次 LLM 请求**就换过去（不等下一轮）。
     */
    getModelKey?: () => string;
    /** 这一轮开始时的完整上下文（session 自己拼：公共条目 + 自己的私有过程） */
    messages: ModelMessage[];
    signal: AbortSignal;
    /** 由调用方分配（同 turn 的多个 bot 共享 turnId） */
    turnId?: string;
    /**
     * 会话 id（provider 的会话路由 / 亲和键；opencode 网关缺了它直接 400 `MissingSessionID`）。
     * 缺省 = 用本轮 `turnId` —— 与旧版「建 provider 时取一次时间戳」同粒度，只是可复现、可测。
     */
    sessionId?: string;
    /** next-step 插入点：SDK 在 step 边界把消息作为独立 user 消息追加 */
    steering?: Experimental_Steering;
    /** 房间装配的工具；不传 = 只用内置的 get_time（测试 / 无目录房间） */
    tools?: ToolSet;
    /** 系统提示里关于工具的一句话（房间知道自己给了哪些能力） */
    toolsHint?: string;
    /**
     * 规则上下文（AGENTS.md 链 + 知识库索引）：由房间在构造时组装一次，session 每轮复用。
     * 不传 = 只有 persona（测试 / 无工作目录的房间）。
     */
    systemContext?: string;
    /**
     * 本步的变量增量（vars 信封）：**每一步都取一次**，与「人说话 / 恢复 /  agent 间结论」
     * 的时机无关。返回空串 = 这一步什么都没变（不注入）。
     *
     * 由房间的 `ContextSession` 提供（`step().user`）；session 只负责在 step 边界调用。
     */
    takeDelta?: () => string;
    /** 该步已经成功收尾 ⇒ 推进快照（`ContextSession.commit()`）；失败 / 重试不推进 */
    commitDelta?: () => void;
    /** 测试注入模型（缺省按 modelKey 解析） */
    model?: LanguageModel;
    /** 测试注入：modelKey → 模型实例（缺省走目录 `modelOf`；per-step 换模型也走它） */
    resolveModel?: (modelKey: string) => LanguageModel;
    /**
     * 每一步结束时回传"本步新增的消息"，按 step 顺序拼接就是这一轮的完整增量：
     *   本步被插入的 steering 用户消息 + 模型产出的 assistant / tool 消息。
     */
    onStepTranscript?: (messages: ModelMessage[]) => void;
    /**
     * 本轮**全部步**的真实用量（token）—— 计费口径（多步时是各步之和）。
     * 不要拿它当上下文水位：40 步 × 20 万会把「20 万上下文」报成 800 万，
     * 压缩判据会因此误触发（2026-11-28 实证：turn=102 一启动就压）。
     */
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
    /**
     * 本轮**结束时的上下文占用**（最后一步的 inputTokens）—— 压缩水位的唯一来源。
     *
     * 为什么不能用 `onUsage`：AI SDK 的 `result.usage` / `totalUsage` 都是**各步之和**
     * （官方注释：sum of all step usages）；一步就把整份上下文重发一遍，求和自然到几百万。
     * 只有 `step.usage`（每一步各自的）回答「这一次请求有多大」。
     */
    onContextUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
    /**
     * 本轮的**输出上限**（`max_tokens`）。不传 = 按 modelKey 推（provider 硬上限 / 场景缺省）。
     * **不要省成 undefined 再指望服务端缺省**：那会让长回答被静默截断（见 `maxOutputTokensOf`）。
     */
    maxOutputTokens?: number;
    /**
     * 停摆判定的时长（首包 / 块间隔 / 工具执行）。不传 = 按环境读缺省（见 `stall-watchdog.ts`）。
     * 测试用它把 3 分钟压成几毫秒。
     */
    stallTimeouts?: { firstMs: number; idleMs: number; toolMs: number };
    /**
     * 可以等任意久的工具（缺省 `['ask']`，见 `stall-watchdog.ts`）：这些不计入工具时段的上限。
     * 传空数组 = 所有工具都受 `stallTimeouts.toolMs` 约束（排障时用）。
     */
    unboundedTools?: Iterable<string>;
    /**
     * 步数上限（工具循环）。不传 = `DEFAULT_MAX_STEPS`。
     *
     * 为什么必须有：`stopWhen` 缺省**不限步数**时，唯一刹车是用户点停止 —— 手动对话没问题，
     * 一旦接上远程 / 后台 / 多端，一次工具循环就能跑到天亮。diy1 的口径是 200（
     * `local-agent.ts` 的分层缺省），这里对齐。
     */
    maxSteps?: number;
    /**
     * 模型窗口（token）。给了就在**每一步**把超量的工具输出折叠掉（见 `context-guard.ts`）——
     * 压缩只在轮首看一次水位，而 200 步的轮次能把请求从 20 万堆到 100 万（2026-11-27 实证）。
     * 未知 ⇒ 不轧（不猜窗口，与压缩判据同一条规矩）。
     */
    windowTokens?: number;
}

/** 缺省步数上限（与 diy1 缺省同值：200）；到顶不算失败，按 `max-steps` 收尾 */
export const DEFAULT_MAX_STEPS = 200;

const defaultTools = {
    get_time: tool({
        description: '获取当前时间（ISO 字符串）',
        inputSchema: z.object({ timezone: z.string().optional().describe('IANA 时区，例如 Asia/Shanghai') }),
        execute: async ({ timezone }) => {
            const now = new Date();
            const text =
                timezone === undefined ? now.toISOString() : now.toLocaleString('zh-CN', { timeZone: timezone });
            return { now: text, timezone: timezone ?? 'UTC' };
        },
    }),
};

/**
 * system 的唯一拼装点（纯函数，便于单测）。
 *
 * 顺序：身份 → persona → 规则上下文 → 工具提示。空段跳过 —— 没有 `systemContext`
 * 时输出与旧版逐字一致（现有测试与已缓存前缀都不受影响）。
 */
export function instructionsOf(opts: {
    botName: string;
    persona: string;
    systemContext?: string;
    toolsHint?: string;
}): string {
    return [
        `你是「${opts.botName}」，这个实体的专属 bot。`,
        opts.persona,
        opts.systemContext ?? '',
        opts.toolsHint ?? '回答简洁；需要时间时调用 get_time 工具。',
    ]
        .filter((part) => part !== '')
        .join('\n');
}

export async function* runAgent(options: RunOptions): AsyncIterable<AgentEvent> {
    /**
     * 事件序号：**只有结构性事件才 +1**（开跑 / 工具调用 / 收尾），增量不带新号。
     *
     * 为什么：投影层把 `seq` 当作条目的版本号（`Projector` 取 `Math.max`）。以前每个
     * `text.delta` 都拿一个新号，于是 `Item.seq` 变成了 **token 计数** —— 一轮几千个 delta
     * 就能把一个本该很小的"第几个事件"推到上万，可读性和可比较性都没了。
     * 修完之后 `seq` 只数事件；但它仍然**不是**全局版本号：落库时 `db.appendItem` 会把
     * 它换成行号（同一件事的两个号），所以判新旧仍然不能只看它 —— 那是下一步的事。
     *
     * 增量共用一个号不会丢信息：一个条目的文本是**累加**的，不需要一个号来区分哪一片。
     */
    let seq = 0;
    const turnId = options.turnId ?? `turn-${Date.now().toString(36)}`;
    const messageId = `msg-${Date.now().toString(36)}`;

    yield { seq: ++seq, type: 'run.started', turnId, messageId };

    // 调用方（session）已经算好了（含 env 覆盖）就直接用，别再算一遍：
    // 两处各算一遍虽然眼下幂等，但 env / provider 上限的规则一改就会漂成两种结果。
    // 只有直接调 `runAgent` 的调用方（测试、一次性跑）才在这里补算。
    const maxOutputTokens = options.maxOutputTokens ?? maxOutputTokensOf(options.modelKey);
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

    /**
     * 自家中止开关：把两条来路了接到同一个 signal —— 调用方（用户点停止）与看门狗（上游停摆）。
     * 合同：调用方的 abort 原样传递（SDK 照旧抛 AbortError），看门狗的中止由下面转成 `run.failed`。
     */
    const stall = new AbortController();
    let stallInfo: StallInfo | undefined;
    const forwardAbort = (): void => stall.abort();
    if (options.signal.aborted) stall.abort();
    else options.signal.addEventListener('abort', forwardAbort, { once: true });
    const watchdog = new StallWatchdog({
        ...(options.stallTimeouts ?? stallTimeoutsFromEnv()),
        ...(options.unboundedTools === undefined ? {} : { unboundedTools: options.unboundedTools }),
        onStall: (info) => {
            stallInfo = info;
            stall.abort();
        },
    });
    watchdog.start();

    const instructions = instructionsOf({
        botName: options.bot.name,
        persona: options.bot.persona,
        ...(options.systemContext === undefined ? {} : { systemContext: options.systemContext }),
        ...(options.toolsHint === undefined ? {} : { toolsHint: options.toolsHint }),
    });
    /**
     * 除 messages 之外已占掉的量（目前只算 system）。
     *
     * 为什么要算：真发出去的是「system + tools + messages」三段之和（diy1 的预检 `estimateRequest`
     * 就是这么量的），只量历史会让「system 本身就很大」的房间永远报告"没超"。
     *
     * **tools 没算**：`ToolSet` 里挂着 `execute` 函数，`JSON.stringify` 既丢不到描述也容易高估
     * （zod schema 的内部结构会炸出一大坨），而工具定义通常只有 3~10k token，1M 窗口下不足 1%。
     * 要算得先把 ToolSet 投影成纯描述，另立一条 —— 不在这里糊一个数。
     */
    const systemTokens = estimateMessagesTokens([{ role: 'system', content: instructions }]);

    // 当前生效的模型键：prepareStep 每步读一次 `getModelKey`，变了就换模型实例
    let currentModelKey = options.modelKey;
    const resolveModel =
        options.resolveModel ??
        ((key: string) => modelOf(key, { sessionId: options.sessionId ?? turnId }));
    const result = streamText({
        model: options.model ?? resolveModel(currentModelKey),
        abortSignal: stall.signal,
        maxOutputTokens,
        instructions,
        messages: options.messages,
        tools: options.tools ?? defaultTools,
        // 步数上限：到顶就停（`stopWhen` 缺省是 1 步，必须显式覆盖；**不能**写成 `() => false`
        // —— 那样唯一刹车就是用户点停止，见 `RunOptions.maxSteps`）。
        stopWhen: stepCountIs(maxSteps),
        /**
         * **每一步**取一次变量增量（与谁触发这一轮无关）：有变化就作为一条独立 user 信封
         * 追加在本步请求的末尾。空串不注入（不加字节、不砸前缀缓存）。
         *
         * 重试会再次进 prepareStep（同一步号）：因为还没 commit，取到的是**同一份**增量
         * （幂等），不会把变化吞掉。
         */
        prepareStep: ({ messages, stepNumber }) => {
            const patch: { model?: LanguageModel; messages?: ModelMessage[] } = {};
            // 换模型：每步读一次当前键（用户刚在界面上切了模型）——
            // 变了就在**本步**换模型实例，而不是等下一轮。
            const nextKey = options.getModelKey?.() ?? options.modelKey;
            if (nextKey !== currentModelKey) {
                currentModelKey = nextKey;
                // 测试注入的 `model` 是固定实例，不跟 modelKey 走
                if (options.model === undefined) patch.model = resolveModel(nextKey);
            }
            /**
             * ① 轮内水位（每一步都看）：把最早的工具输出折掉，免得 200 步的轮次把请求堆过窗口。
             *    第 0 步不折 —— 那时一条工具结果都还没产生，折的只可能是历史（那是压缩的活）。
             */
            const guarded =
                options.windowTokens === undefined || stepNumber === 0
                    ? null
                    : guardMessages(messages, { windowTokens: options.windowTokens, fixedTokens: systemTokens });
            const base = guarded === null ? messages : guarded.messages;
            // ② 变量增量（不折它：它是本步的新信息，而且很小）
            const delta = options.takeDelta?.() ?? '';
            if (delta !== '') patch.messages = [...base, { role: 'user', content: delta }];
            else if (guarded !== null) patch.messages = base;
            return patch;
        },
        /**
         * **这一层不重试**（2026-11-25 用户裁决）：SDK 内部重试把三次失败揉成一个
         * `RetryError`，外面既看不到试了几次、也没法按自己的退避节奏来。要重试就加在外面
         * （能观测的那层）。这里只跑一次。
         */
        maxRetries: 0,
        /**
         * SDK 的缺省 onError 是 `console.error(error)` —— 它用 util.inspect 展开整棵
         * RetryError 树（每层带 responseBody / responseHeaders / 完整 messages 与 tools），
         * 几百行，而且没进日志文件（重启即失）。接过来只记一行：可读话术 + 状态码，
         * 原始错误的类型 / 消息 / 栈交给日志装配落 jsonl。
         */
        onError: ({ error }) => {
            agentLog.emit({
                severityNumber: SeverityNumber.WARN,
                body: 'LLM 请求失败（不重试）',
                attributes: {
                    turnId,
                    modelKey: currentModelKey,
                    botId: options.bot.id,
                    reason: friendlyError(error),
                    ...(statusOf(error) === undefined ? {} : { status: statusOf(error) }),
                    ...exceptionAttributesOf(error),
                },
            });
        },
        ...(options.steering === undefined ? {} : { experimental_steering: options.steering }),
        onStepFinish: (step) => {
            // 最后一步的用量 = 这一轮结束时的上下文占用（压缩水位）。多步之和是计费口径，
            // 见 RunOptions.onContextUsage —— 两者不能混。
            lastStepUsage = step.usage;
            // 这一步成功收尾 ⇒ 快照前移（失败 / 重试不进这里，下一轮会重新算同一份增量）
            options.commitDelta?.();
            if (options.onStepTranscript === undefined) return;
            // 工具输出已在**投递层**截过（`toModelOutput` → `tool-output.ts`）：这里拿到的
            // `step.response.messages` 就是模型实际收到的版本，不需要再裁开。
            options.onStepTranscript([...(step.experimental_steeringMessages ?? []), ...step.response.messages]);
        },
    });

    /** 收尾事实：截断 / 工具悬空 / 正常说完，全靠这三个值分辨（见 docs 里的 `##429`） */
    let finishReason = 'unknown';
    let steps = 0;
    /**
     * 最后一步的用量（每一步各自的大小）。`result.usage` 是**各步之和**，不能用它判断
     * 「当前上下文多大」—— 那是计费口径，会随步数线性膨胀。
     */
    let lastStepUsage: LanguageModelUsage | undefined;
    /** 是否撞到步数上限（只在「还想继续调工具」时改写收尾原因，见循环后那段） */
    let hitStepCap = false;

    try {
        for await (const part of result.stream) {
            // 有数据 = 上游还活着；工具调用之后的等待算「工具在执行」而不是「上游在挂」
            // （`ask` 等用户多久都行 —— 它在豁免名单里；其余工具受 `toolMs` 兑底，见 ##560）
            if (part.type === 'tool-call') watchdog.toolStart(part.toolName);
            else watchdog.touch();
            switch (part.type) {
                case 'finish-step':
                    steps += 1;
                    if (steps >= maxSteps) hitStepCap = true;
                    break;
                case 'finish':
                    // 这是**唯一**能看出「被输出上限砍断」的地方：SDK 在 length 时只是结束循环，
                    // 不发 error part。以前这里落进 default，于是截断在数据里长得和成功一样。
                    finishReason = part.finishReason ?? 'unknown';
                    break;
                case 'abort':
                    finishReason = 'aborted';
                    break;
                case 'text-delta':
                    // 不占新号：同一个条目的每一次追加都是它的同一个版本（见函数头的 `seq`）
                    yield { seq, type: 'text.delta', messageId, delta: part.text };
                    break;
                case 'reasoning-delta':
                    yield { seq, type: 'reasoning.delta', messageId, delta: part.text };
                    break;
                case 'tool-call':
                    yield {
                        seq: ++seq,
                        type: 'tool.started',
                        turnId,
                        toolCallId: part.toolCallId,
                        name: part.toolName,
                        args: part.input,
                    };
                    break;
                case 'tool-result':
                    yield {
                        seq: ++seq,
                        type: 'tool.completed',
                        turnId,
                        toolCallId: part.toolCallId,
                        name: part.toolName,
                        // 图已经交给模型看过了，事件里只留一行说明（这个事件会进 db）
                        result: scrubMedia(part.output),
                    };
                    break;
                case 'tool-error':
                    yield {
                        seq: ++seq,
                        type: 'tool.completed',
                        turnId,
                        toolCallId: (part as { toolCallId: string }).toolCallId,
                        name: (part as { toolName?: string }).toolName ?? 'tool',
                        error: String((part as { error?: unknown }).error ?? 'tool error'),
                    };
                    break;
                case 'error': {
                    const failure = (part as { error?: unknown }).error;
                    yield {
                        seq: ++seq,
                        type: 'run.failed',
                        turnId,
                        message: friendlyError(failure),
                        // 超窗是**可自愈**的事实，交给 session 去压缩重试（话术骗不了它）
                        ...(isContextOverflow(failure) ? { overflow: true as const } : {}),
                    };
                    return;
                }
                default:
                    break;
            }
        }
    } catch (error) {
        watchdog.stop();
        options.signal.removeEventListener('abort', forwardAbort);
        // 看门狗掐的和用户按停的都会走到这里：**只有看门狗那条**要说成“停摆”（用户按停不能冤枉上游，
        // 反之停摆也不该被当成人取消 —— 那样用户会以为是自己点错了）
        if (stallInfo !== undefined && !options.signal.aborted) {
            // `stall` 把「卡在哪个时段 / 等了多久」带给上层：收尾判据靠它把这一轮落成
            // `stalled` 而不是一般 `error`（杀它的这一层不说是哪个，上层就只剩猜测）
            yield { seq: ++seq, type: 'run.failed', turnId, message: stallMessage(stallInfo), stall: stallInfo };
            return;
        }
        yield {
            seq: ++seq,
            type: 'run.failed',
            turnId,
            message: friendlyError(error),
            ...(isContextOverflow(error) ? { overflow: true as const } : {}),
        };
        return;
    } finally {
        watchdog.stop();
        options.signal.removeEventListener('abort', forwardAbort);
    }

    // 流在正常路径上结束（被 abort 时 ai-sdk 可能给一个 `abort` part 而不是抛）：
    // 停摆仍要算失败 —— 不能因为“循环退出了”就把它当正常收尾
    if (stallInfo !== undefined && !options.signal.aborted) {
        yield { seq: ++seq, type: 'run.failed', turnId, message: stallMessage(stallInfo), stall: stallInfo };
        return;
    }

    try {
        const usage = await result.totalUsage;
        options.onUsage?.({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
    } catch {
        // 用量拿不到不影响这一轮
    }
    // 上下文水位单独报：只认最后一步，不认多步求和（见 RunOptions.onContextUsage 的注释）
    if (lastStepUsage !== undefined) {
        options.onContextUsage?.({
            inputTokens: lastStepUsage.inputTokens ?? 0,
            outputTokens: lastStepUsage.outputTokens ?? 0,
        });
    }

    // 撞到步数上限：只有「上游还想继续调工具」（finish=tool-calls）才算"是被上限掐停的"。
    // 第 200 步刚好自然说完（finish=stop）不改写 —— 那不是掐停，别把正常收尾降级成未完成。
    if (hitStepCap && finishReason === 'tool-calls') finishReason = 'max-steps';

    yield { seq: ++seq, type: 'run.finished', turnId, finishReason, steps, maxOutputTokens, maxSteps };
    yield { seq: ++seq, type: 'message.completed', messageId };
    yield { seq: ++seq, type: 'run.completed', turnId };
}

/**
 * HTTP 状态码：`APICallError` 自己带；`RetryError` 包在外面（`lastError`）。
 * 不重试之后其实只剩前一种，但 SDK 换版本时这层不该脆。
 */
function statusOf(error: unknown): number | undefined {
    const seen = new Set<unknown>();
    let cur: unknown = error;
    while (cur !== null && typeof cur === 'object' && !seen.has(cur)) {
        seen.add(cur);
        const status = (cur as { statusCode?: unknown }).statusCode;
        if (typeof status === 'number') return status;
        cur = (cur as { lastError?: unknown }).lastError ?? (cur as { cause?: unknown }).cause;
    }
    return undefined;
}

/**
 * OTel 的异常约定（`exception.*`）：`@diy-agent/log` 的导出器认这几个 key，
 * 会还原成 jsonl 里的 `err` 字段（带栈）；不按约定的自定义 key 会被当成普通 data。
 */
function exceptionAttributesOf(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) return { 'exception.message': String(error) };
    return {
        'exception.type': error.name,
        'exception.message': error.message,
        ...(error.stack === undefined ? {} : { 'exception.stacktrace': error.stack }),
    };
}
