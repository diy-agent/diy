// agent.ts —— 一次 bot 运行：streamText → AgentEvent（文本 / 推理 / 工具 / 结束）。
//
// 除了"给 UI 看的事件流"，这里还负责把**这一轮真正喂进模型的完整消息**回传给调用方
// （assistant 带 tool call / tool result / reasoning 都在里面），session 用它维护自己的原生对话。

import {
    stepCountIs,
    streamText,
    tool,
    type Experimental_Steering,
    type LanguageModel,
    type ModelMessage,
    type ToolSet,
} from 'ai';
import { z } from 'zod';

import { friendlyError } from './errors';
import { maxOutputTokensOf, modelOf } from './providers';
import { StallWatchdog, stallMessage, stallTimeoutsFromEnv, type StallInfo } from './stall-watchdog';
import { clipModelMessage } from './tools/clip';
import type { AgentEvent, Bot } from './types';

export interface RunOptions {
    bot: Bot;
    modelKey: string;
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
    /**
     * 每一步结束时回传"本步新增的消息"，按 step 顺序拼接就是这一轮的完整增量：
     *   本步被插入的 steering 用户消息 + 模型产出的 assistant / tool 消息。
     */
    onStepTranscript?: (messages: ModelMessage[]) => void;
    /** 本轮真实用量（token），用于校准压缩预算 */
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
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
     * 步数上限（工具循环）。不传 = `DEFAULT_MAX_STEPS`。
     *
     * 为什么必须有：`stopWhen` 缺省**不限步数**时，唯一刹车是用户点停止 —— 手动对话没问题，
     * 一旦接上远程 / 后台 / 多端，一次工具循环就能跑到天亮。diy1 的口径是 200（
     * `local-agent.ts` 的分层缺省），这里对齐。
     */
    maxSteps?: number;
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
        onStall: (info) => {
            stallInfo = info;
            stall.abort();
        },
    });
    watchdog.start();

    const result = streamText({
        model:
            options.model ??
            modelOf(options.modelKey, { sessionId: options.sessionId ?? turnId }),
        abortSignal: stall.signal,
        maxOutputTokens,
        instructions: instructionsOf({
            botName: options.bot.name,
            persona: options.bot.persona,
            ...(options.systemContext === undefined ? {} : { systemContext: options.systemContext }),
            ...(options.toolsHint === undefined ? {} : { toolsHint: options.toolsHint }),
        }),
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
        prepareStep: ({ messages }) => {
            const delta = options.takeDelta?.() ?? '';
            if (delta === '') return {};
            return { messages: [...messages, { role: 'user', content: delta }] };
        },
        // 连接超时这类瞬时错误自动重试；不可重试的错误 SDK 自己会跳过
        maxRetries: 2,
        ...(options.steering === undefined ? {} : { experimental_steering: options.steering }),
        onStepFinish: (step) => {
            // 这一步成功收尾 ⇒ 快照前移（失败 / 重试不进这里，下一轮会重新算同一份增量）
            options.commitDelta?.();
            if (options.onStepTranscript === undefined) return;
            // 工具输出只裁"喂给模型"的那份；UI 的 tool-result 事件仍然是完整输出
            options.onStepTranscript([
                ...(step.experimental_steeringMessages ?? []),
                ...step.response.messages.map((message) => clipModelMessage(message)),
            ]);
        },
    });

    /** 收尾事实：截断 / 工具悬空 / 正常说完，全靠这三个值分辨（见 docs 里的 `##429`） */
    let finishReason = 'unknown';
    let steps = 0;
    /** 是否撞到步数上限（只在「还想继续调工具」时改写收尾原因，见循环后那段） */
    let hitStepCap = false;

    try {
        for await (const part of result.stream) {
            // 有数据 = 上游还活着；工具调用之后的等待算「工具在执行」而不是「上游在挂」
            // （`ask` 可能要等用户很久、`job wait` 能等 10 分钟：那些不能当停摆掐掉）
            if (part.type === 'tool-call') watchdog.toolStart();
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
                        result: part.output,
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
                case 'error':
                    yield {
                        seq: ++seq,
                        type: 'run.failed',
                        turnId,
                        message: friendlyError((part as { error?: unknown }).error),
                    };
                    return;
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
            yield { seq: ++seq, type: 'run.failed', turnId, message: stallMessage(stallInfo) };
            return;
        }
        yield { seq: ++seq, type: 'run.failed', turnId, message: friendlyError(error) };
        return;
    } finally {
        watchdog.stop();
        options.signal.removeEventListener('abort', forwardAbort);
    }

    // 流在正常路径上结束（被 abort 时 ai-sdk 可能给一个 `abort` part 而不是抛）：
    // 停摆仍要算失败 —— 不能因为“循环退出了”就把它当正常收尾
    if (stallInfo !== undefined && !options.signal.aborted) {
        yield { seq: ++seq, type: 'run.failed', turnId, message: stallMessage(stallInfo) };
        return;
    }

    try {
        const usage = await result.totalUsage;
        options.onUsage?.({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
    } catch {
        // 用量拿不到不影响这一轮
    }

    // 撞到步数上限：只有「上游还想继续调工具」（finish=tool-calls）才算"是被上限掐停的"。
    // 第 200 步刚好自然说完（finish=stop）不改写 —— 那不是掐停，别把正常收尾降级成未完成。
    if (hitStepCap && finishReason === 'tool-calls') finishReason = 'max-steps';

    yield { seq: ++seq, type: 'run.finished', turnId, finishReason, steps, maxOutputTokens, maxSteps };
    yield { seq: ++seq, type: 'message.completed', messageId };
    yield { seq: ++seq, type: 'run.completed', turnId };
}
