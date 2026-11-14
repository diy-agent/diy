// ask.ts —— 向用户提问：模型需要人做决定时，停下来把选项/表单推到界面上。
//
// 为什么不用 AI SDK 的 `needsApproval` 暂停-恢复：那套要把响应重新拼进 messages 再续跑，
// 和"一轮 SSE 一直开着"的模型不匹配。这里让工具停在 await 上，用户的回答通过一次 HTTP
// 调回来，同一个 run 继续 —— 简单、可取消。
//
// 与"审批"的区别：这里问的是**决策**（选哪个方案 / 填几个字段），不是"允许不允许"。
// 放在正文里问容易被大段输出淹掉，所以必须是置顶的选项 / 表单。

import type { AskAnswer, AskField, AskOption, AskRequest } from './types';

/** 工具侧的提问入参（不含 askId，由闸门分配） */
export interface AskInput {
    question: string;
    kind?: 'choice' | 'form';
    options?: AskOption[];
    fields?: AskField[];
    multiple?: boolean;
    note?: string;
}

export interface AskGateDeps {
    /** 新提问：房间把它推到界面 */
    request: (request: AskRequest) => void;
    /** 已回答 / 取消：房间收尾（更新提示、留痕） */
    settle: (request: AskRequest, result: { answer?: AskAnswer; cancelled?: boolean; reason?: string }) => void;
    /** 等待上限（毫秒）；缺省 10 分钟；0 = 一直等 */
    timeoutMs?: number;
    now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** 一次提问的结果（带上 request，调用方不用自己再拼一份） */
export interface AskOutcome {
    request: AskRequest;
    answer?: AskAnswer;
    cancelled?: boolean;
    reason?: string;
}

export class AskGate {
    private readonly pending = new Map<
        string,
        {
            request: AskRequest;
            resolve: (result: AskOutcome) => void;
            timer?: NodeJS.Timeout;
        }
    >();
    private counter = 0;

    constructor(private readonly deps: AskGateDeps) {}

    /** 工具一侧调用：挂起直到用户回答 */
    request(input: AskInput): Promise<AskOutcome> {
        const at = this.deps.now?.() ?? Date.now();
        const askId = `ask-${at.toString(36)}-${++this.counter}`;
        const request: AskRequest = {
            askId,
            question: input.question,
            kind: input.kind ?? (input.fields === undefined ? 'choice' : 'form'),
            ...(input.options === undefined ? {} : { options: input.options }),
            ...(input.fields === undefined ? {} : { fields: input.fields }),
            ...(input.multiple === undefined ? {} : { multiple: input.multiple }),
            ...(input.note === undefined ? {} : { note: input.note }),
            at,
        };

        const promise = new Promise<AskOutcome>((resolve) => {
            const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => this.settle(askId, { cancelled: true, reason: '等待回答超时' }), timeoutMs)
                    : undefined;
            this.pending.set(askId, { request, resolve, ...(timer === undefined ? {} : { timer }) });
        });

        try {
            this.deps.request(request);
        } catch (error) {
            // 推不到界面上就别让它挂成孤儿：直接按取消收尾
            const reason = error instanceof Error ? error.message : String(error);
            this.settle(askId, { cancelled: true, reason: `无法显示提问：${reason}` });
        }
        return promise;
    }

    /** 用户的回答；返回是否命中一个待回答的提问 */
    answer(askId: string, answer: AskAnswer): boolean {
        return this.settle(askId, { answer });
    }

    /** 取消这一轮：所有挂起的提问按"取消"收尾，run 才能退出 */
    cancelAll(reason = '本轮已取消'): void {
        for (const askId of [...this.pending.keys()]) this.settle(askId, { cancelled: true, reason });
    }

    pendingCount(): number {
        return this.pending.size;
    }

    list(): AskRequest[] {
        return [...this.pending.values()].map((entry) => entry.request);
    }

    private settle(askId: string, result: Omit<AskOutcome, 'request'>): boolean {
        const entry = this.pending.get(askId);
        if (entry === undefined) return false;
        this.pending.delete(askId);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        this.deps.settle(entry.request, result);
        entry.resolve({ request: entry.request, ...result });
        return true;
    }
}
