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
// **一批可带多题**：三条相关的事（口径 / 拓扑 / 落地到哪步）以前要连调三次工具，
// 界面上三张卡、点三次提交、模型收到三条独立消息。现在一次问完、一次提交整批。
// 与 dsh（questions[]）/ opencode（questions[] → Form fields）/ assistant-ui
// （display:'questions'）的契约一致。
//
// 与"审批"的区别：这里问的是**决策**（选哪个方案 / 填几个字段），不是"允许不允许"。
// 放在正文里问容易被大段输出淹掉，所以必须是置顶的选项 / 表单。

import type { AnsweredAsk, AskAnswer, AskField, AskOption, AskQuestion, AskRequest } from './types';

// 答案表述与旧快照归一化搬去了 protocol（前端也要用同一份），这里再导出保持调用方路径不变
export {
    answerFor,
    askAnswerHeading,
    describeAnswer,
    describeQuestionAnswer,
    normalizeAskRequest,
} from '@diy-agent/protocol';

/** 工具侧的一题（不含 id，缺省由闸门分配 q1/q2…） */
export interface AskQuestionInput {
    id?: string;
    question: string;
    kind?: 'choice' | 'form' | 'text';
    options?: AskOption[];
    fields?: AskField[];
    multiple?: boolean;
    allowFreeform?: boolean;
    note?: string;
    /** 这题是否必须作答，缺省 true */
    required?: boolean;
}

/**
 * 工具侧的提问入参（不含 askId，由闸门分配）。
 *
 * 两种形式都收：批量用 `questions`；只问一件事时可以直接给 `question`（模型少写一层数组，
 * 测试也不必改一圈）。**协议里只有一种形状**（`AskRequest.questions`），这里只是入口的简写。
 */
export type AskInput =
    | {
          questions: AskQuestionInput[];
          /** 整批的背景说明 */
          note?: string;
          toolCallId?: string;
      }
    | (AskQuestionInput & { toolCallId?: string });

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

/** 回答的结局：三种情况给界面的处理完全不同，不能都报成"已失效" */
export type AnswerOutcome =
    | { ok: true }
    | { ok: false; code: 'no-such-ask' }
    | { ok: false; code: 'bad-answer'; reason: string };

/**
 * 整批回答合不合法；合法返回 undefined，否则返回给人看的原因。
 *
 * 只抓"客户端漏题 / 多题 / 题 id 对不上"，**不深究内容**（选题、必填都在界面上拦）：
 * 在这里二次校验一遍文案，只会在"用户清空了输入"这类良性情形下把人挡在外面。
 * 跳过是合法的 —— 但必须显式带 `skipped: true`，否则和"漏了"区分不开。
 */
function badAnswerOf(request: AskRequest, answer: AskAnswer): string | undefined {
    if (!Array.isArray(answer.answers)) return '答案格式不对：应为 { answers: [...] }';
    const expected = request.questions.map((question) => question.id);
    const got = answer.answers.map((entry) => entry.id);
    // 只要求必答题都在：`required: false` 的题可以整条不出现（界面会直接跳过它）
    const missing = request.questions
        .filter((question) => question.required !== false)
        .map((question) => question.id)
        .filter((id) => !got.includes(id));
    const extra = got.filter((id) => !expected.includes(id));
    if (missing.length > 0) return `还有 ${missing.length} 题没作答：${missing.join('、')}`;
    if (extra.length > 0) return `答案里有不存在的题：${extra.join('、')}`;
    return undefined;
}

/**
 * 把一题输入归一成协议里的题目。kind 缺省按"有 fields 就是 form，否则 choice"推断。
 * 无内容的题（question 空）返回 undefined：拒绝造一张空卡片。
 */
function normalizeInput(input: AskQuestionInput, index: number): AskQuestion | undefined {
    const question = input.question.trim();
    if (question === '') return undefined;
    const id = input.id === undefined || input.id.trim() === '' ? `q${index + 1}` : input.id.trim();
    const kind = input.kind ?? (input.fields === undefined ? 'choice' : 'form');
    return {
        id,
        question,
        kind,
        ...(input.options === undefined ? {} : { options: input.options }),
        ...(input.fields === undefined ? {} : { fields: input.fields }),
        ...(input.multiple === undefined ? {} : { multiple: input.multiple }),
        ...(input.allowFreeform === undefined ? {} : { allowFreeform: input.allowFreeform }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.required === undefined ? {} : { required: input.required }),
    };
}

/** 两种入口形式 → 题目数组（丢掉空题；全部为空时就是没问成） */
export function questionsOfInput(input: AskInput): { questions: AskQuestion[]; note?: string } {
    const raw = 'questions' in input ? input.questions : [input];
    const questions: AskQuestion[] = [];
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
        const question = normalizeInput(entry, questions.length);
        // id 撞了会让回答对不上题：后来的改个名，不丢内容
        if (question === undefined) return;
        let id = question.id;
        let bump = index + 1;
        while (seen.has(id)) id = `q${++bump}`;
        seen.add(id);
        questions.push({ ...question, id });
    });
    const note = input.note;
    return { questions, ...(note === undefined ? {} : { note }) };
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
     *
     * 一题都凑不出来时不推卡片（返回 undefined）：造一张空卡片只会让用户困惑。
     */
    request(input: AskInput, owner?: string): AskRequest | undefined {
        const { questions, note } = questionsOfInput(input);
        if (questions.length === 0) return undefined;
        const at = this.deps.now?.() ?? Date.now();
        const askId = `ask-${at.toString(36)}-${++this.counter}`;
        // 提在谁的那一轮里：立刻记下来。等卡片回到界面时（可能几万条之后、甚至刷新后）
        // 那条工具行早就不在窗口里了，那时再想反推已经无处可查。
        const turnId = this.deps.turnOf?.(input.toolCallId);
        const request: AskRequest = {
            askId,
            questions,
            ...(note === undefined ? {} : { note }),
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

    /**
     * 用户的回答（整批一次提交）；返回结局。
     *
     * 为什么要三态而不是 boolean：以前 false 只会是"这一问已经失效"（→ 404）；
     * 现在整批提交还有第二种失败 —— 少一题或多一题（→ 400，例如客户端缓存了旧题集，
     * 或者用户只填了前两题）。两种情况给界面的话完全不同，不能都报成"已失效"。
     * dsh 同样用 BAD_ANSWER 区分这件事，并**拒掉整批**而不是收下残缺的一份。
     */
    answer(askId: string, answer: AskAnswer): AnswerOutcome {
        const entry = this.pending.get(askId);
        if (entry === undefined) return { ok: false, code: 'no-such-ask' };
        const bad = badAnswerOf(entry.request, answer);
        if (bad !== undefined) return { ok: false, code: 'bad-answer', reason: bad };
        this.settle(askId, { answer });
        return { ok: true };
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
