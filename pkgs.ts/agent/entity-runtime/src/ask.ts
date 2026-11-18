// ask.ts —— 向用户提问：模型需要人做决定时，把选项/表单推到界面上。
//
// **不阻塞**：工具调用立刻拿到「提问已发出」的回执，本轮照常跑完、流照常关闭。
// 用户之后作答时，回答变成一条**用户消息**投给提问的成员 —— 有 run 在跑就在下一个
// step 边界注入，没有就开新轮。所以不需要"恢复执行栈"：run 的状态全在 transcript 里。
//
// 为什么不用阻塞式（await 到回答）：那样 run 会一直挂在一个 promise 上，用户在等待期间
// 想说别的话都发不进去（steering 只在 step 边界生效，而 step 边界要等 ask 返回）。
// 唯一的硬约束是"每个 tool call 都必须有 result"，立即返回一样满足。
//
// 与"审批"的区别：这里问的是**决策**（选哪个方案 / 填几个字段），不是"允许不允许"。
// 放在正文里问容易被大段输出淹掉，所以必须是置顶的选项 / 表单。

import type { AnsweredAsk, AskAnswer, AskField, AskOption, AskRequest } from './types';

/** 工具侧的提问入参（不含 askId，由闸门分配） */
export interface AskInput {
    question: string;
    kind?: 'choice' | 'form' | 'text';
    options?: AskOption[];
    fields?: AskField[];
    multiple?: boolean;
    allowFreeform?: boolean;
    note?: string;
    toolCallId?: string;
}

/** 一次提问的结局：被回答，或被取消（容器关闭 / 超时 / 被新提问挤掉） */
export interface AskResult {
    answer?: AskAnswer;
    cancelled?: boolean;
    reason?: string;
    /**
     * 被取消时是否要**告诉提问的成员**这张卡作废了。
     *
     * 默认不告诉：容器关闭 / 成员被移除时，会话本身已经结束，投一条消息没有收件人。
     * 但两种情况下必须告诉 —— 那个成员还在原地看着，它没有 tool call 能回填
     *（ask 不阻塞），不通知就会永远停在「我以为我问了、等回答」：
     *   · 「同时待回答太多、最旧的一条被挤掉」；
     *   · 用户主动「撤回了这一问」。
     */
    notifyOwner?: boolean;
}

export interface AskGateDeps {
    /** 新提问：房间把它推到界面 */
    request: (request: AskRequest) => void;
    /**
     * 某个工具调用发生在哪一轮（房间按 toolCallId 记账）。
     *
     * 有了它，提问卡片才能在创建时就带上自己的 `turnId`，而不是事后让 UI 靠工具行去反推 ——
     * 那条工具行可能早就滑出窗口了（见 `AskRequest.turnId`）。
     */
    turnOf?: (toolCallId: string | undefined) => string | undefined;
    /** 回答 / 取消：房间收尾（广播、留痕、把回答变成一条消息）。owner = 提问的成员。 */
    settle: (request: AskRequest, result: AskResult, owner?: string) => void;
    /** 挂在界面上的上限（毫秒）；缺省 0 = 一直等着（用户随时可以回头答） */
    timeoutMs?: number;
    now?: () => number;
}

/**
 * 把回答整理成模型能直接读懂的一行行文本。
 * 房间投递回答消息、工具返回回执都用它 —— 两处表述必须一致，否则模型会当成两件事。
 */
export function describeAnswer(request: AskRequest, answer: AskAnswer | undefined): string {
    if (answer === undefined) return '（没有回答）';
    if (request.kind === 'text') {
        // 注意不能写 `answer.text?.trim() ?? '（空）'`：空串过不了 ??，会拼出「回答提问「…」：」后面什么都没有
        const text = answer.text?.trim() ?? '';
        return text === '' ? '（空）' : text;
    }
    if (request.kind === 'form') {
        const lines = (request.fields ?? []).map(
            (field) => `- ${field.label}：${answer.fields?.[field.name] ?? '（未填）'}`,
        );
        const extra = answer.text?.trim() ?? '';
        const body = lines.length === 0 ? '（没有字段）' : lines.join('\n');
        return extra === '' ? body : `${body}\n补充：${extra}`;
    }
    const values = answer.values ?? [];
    const freeText = answer.text?.trim() ?? '';
    // 只填了自由输入、没勾选项：这段文字是用户唯一的回答，不能丢
    if (values.length === 0) return freeText === '' ? '（空）' : freeText;
    const labels = values.map((value) => {
        const option = request.options?.find((candidate) => candidate.value === value);
        return option === undefined ? value : `${option.label}（${value}）`;
    });
    const picked = labels.join('、');
    return freeText === '' ? picked : `${picked}；补充：${freeText}`;
}

export class AskGate {
    private readonly pending = new Map<
        string,
        {
            request: AskRequest;
            timer?: NodeJS.Timeout;
            /** 谁问的（成员 id）：回答要投给他 */
            owner?: string;
        }
    >();
    /**
     * 已经有结局的提问（新→旧）。为什么要留：卡片要带着「已选」状态留在时间线上，
     * 否则回答一提交整块选项就消失，用户看不到自己选的是哪一个、其余选项是哪些。
     * 只留最近的，长房间里没必要把几百张旧卡片都挂在内存里（翻回去就没有卡片，可接受）。
     */
    private readonly settled: AnsweredAsk[] = [];
    private counter = 0;

    /** 已收尾的提问保留条数 */
    private static readonly KEEP = 50;

    /** 同时待回答的上限（见 `request` 里的淘汰逻辑） */
    private static readonly MAX_PENDING = 20;

    constructor(private readonly deps: AskGateDeps) {}

    /**
     * 工具一侧调用：把提问推到界面并立刻返回（不等回答）。
     * owner = 提问的成员，回答时按它投递。
     */
    request(input: AskInput, owner?: string): AskRequest {
        const at = this.deps.now?.() ?? Date.now();
        const askId = `ask-${at.toString(36)}-${++this.counter}`;
        // 提在谁的那一轮里：立刻记下来。等卡片回到界面时（可能几万条之后、甚至刷新后）
        // 那条工具行早就不在窗口里了，那时再想反推已经无处可查。
        const turnId = this.deps.turnOf?.(input.toolCallId);
        const request: AskRequest = {
            askId,
            question: input.question,
            kind: input.kind ?? (input.fields === undefined ? 'choice' : 'form'),
            ...(input.options === undefined ? {} : { options: input.options }),
            ...(input.fields === undefined ? {} : { fields: input.fields }),
            ...(input.multiple === undefined ? {} : { multiple: input.multiple }),
            ...(input.allowFreeform === undefined ? {} : { allowFreeform: input.allowFreeform }),
            ...(input.note === undefined ? {} : { note: input.note }),
            ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
            ...(owner === undefined ? {} : { owner }),
            ...(turnId === undefined ? {} : { turnId }),
            at,
        };

        // 同时待回答的上限：全 async 之后模型能连着问，不封顶就是卡片无限堆、
        // 内存只增不减（以前阻塞时代最多同时挂一个，所以没有这个问题）。
        // 满了就作废**最旧**的一条并留痕 —— 新的提问仍然要能显示，
        // 静默丢新的会让模型以为问了、界面却没有。
        while (this.pending.size >= AskGate.MAX_PENDING) {
            const oldest = this.pending.keys().next();
            if (oldest.done === true) break;
            // notifyOwner：淘汰不通知＝模型那边永远留着一个没有下文的提问
            this.settle(oldest.value, {
                cancelled: true,
                reason: `同时待回答的提问太多（上限 ${AskGate.MAX_PENDING}），最旧的一条已作废`,
                notifyOwner: true,
            });
        }

        const timeoutMs = this.deps.timeoutMs ?? 0;
        const timer =
            timeoutMs > 0
                ? setTimeout(() => this.settle(askId, { cancelled: true, reason: '等待回答超时' }), timeoutMs)
                : undefined;
        this.pending.set(askId, {
            request,
            ...(timer === undefined ? {} : { timer }),
            ...(owner === undefined ? {} : { owner }),
        });

        try {
            this.deps.request(request);
        } catch (error) {
            // 推不到界面上就别留着这张永远等不到的卡片
            const reason = error instanceof Error ? error.message : String(error);
            this.settle(askId, { cancelled: true, reason: `无法显示提问：${reason}` });
        }
        return request;
    }

    /** 用户的回答；返回是否命中一个待回答的提问 */
    answer(askId: string, answer: AskAnswer): boolean {
        return this.settle(askId, { answer });
    }

    /**
     * 撤回**某一问**：用户不想答了。
     *
     * 与 `cancelAll` / `cancelFor` 的区别：那两条是环境让提问失效（容器关了、成员走了），
     * 收件人已经不在，通知没意义；这一条是用户主动处置一张还活着的卡片，提问的成员
     * 还在原地看着且没有 tool call 能回填 —— 所以必须 `notifyOwner`，否则它会永远停在
     * 「我问了、等回答」。
     *
     * 也**不是**「停止本轮」：ask 不阻塞，这一轮早就跑完了，停运行跟这张卡无关
     * （见 `cancelAll` 的注释与 `room.cancel`）。
     */
    cancel(askId: string, reason = '提问已被撤回'): boolean {
        return this.settle(askId, { cancelled: true, reason, notifyOwner: true });
    }

    /**
     * 清掉所有待回答的提问（容器关闭 / 成员被移除）。
     * 用户点「停止」不该走这里：那一轮早就跑完了，提问还得留着等他回答。
     */
    cancelAll(reason = '提问已失效'): void {
        // 边遍历边删：先快照 id，不依赖迭代器的删除语义
        const ids = Array.from(this.pending.keys());
        for (const askId of ids) this.settle(askId, { cancelled: true, reason });
    }

    /** 只清某个成员的提问；返回清掉了几个 */
    cancelFor(owner: string, reason = '提问已失效'): number {
        let count = 0;
        const ids = Array.from(this.pending.keys());
        for (const askId of ids) {
            if (this.pending.get(askId)?.owner !== owner) continue;
            if (this.settle(askId, { cancelled: true, reason })) count += 1;
        }
        return count;
    }

    pendingCount(): number {
        return this.pending.size;
    }

    list(): AskRequest[] {
        return [...this.pending.values()].map((entry) => entry.request);
    }

    /** 已收尾的提问（旧→新，与时间线同向） */
    answeredList(): AnsweredAsk[] {
        return [...this.settled].reverse();
    }

    private settle(askId: string, result: AskResult): boolean {
        const entry = this.pending.get(askId);
        if (entry === undefined) return false;
        this.pending.delete(askId);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        this.settled.push({
            request: entry.request,
            ...(result.answer === undefined ? {} : { answer: result.answer }),
            ...(result.cancelled === true ? { cancelled: true } : {}),
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            at: this.deps.now?.() ?? Date.now(),
        });
        if (this.settled.length > AskGate.KEEP) this.settled.splice(0, this.settled.length - AskGate.KEEP);
        this.deps.settle(entry.request, result, entry.owner);
        return true;
    }
}
