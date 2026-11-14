// approval.ts —— 工具审批：模型想写文件 / 执行命令时，先停下来问人。
//
// 为什么不用 AI SDK 的 `needsApproval` 暂停-恢复：那套要求把审批响应重新拼进 messages
// 再续跑，和我们的"一轮 SSE 一直开着"模型不匹配。这里让 execute 停在 await 上，
// 用户的决定通过一次 HTTP 调用回来，同一个 run 继续 —— 简单、可取消、可超时。
//
// 一次审批的生命周期：
//   tools.execute 调 `gate.request()` → 房间发一条 approval 条目（UI 显示允许/拒绝）
//   → 用户点任意一个 → POST /rooms/:id/approvals/:approvalId → gate.resolve()
//   → execute 继续（批准）或抛错（拒绝，模型据此换做法）
//
// 拒绝是"数据"不是"崩溃"：抛错让 SDK 记成 tool-error，模型能看到原因并调整。

export type { ApprovalRequest };

import type { ApprovalRequest } from './types';

export interface ApprovalDecision {
    approved: boolean;
    reason?: string;
}

export interface ApprovalGateDeps {
    /** 新请求：房间把它变成一条 approval 条目 */
    request: (request: ApprovalRequest) => void;
    /** 请求被解决（批准 / 拒绝 / 取消 / 超时）：房间更新那条条目 */
    settle: (request: ApprovalRequest, decision: ApprovalDecision) => void;
    /** 等待上限，缺省 10 分钟；超时按拒绝处理 */
    timeoutMs?: number;
    now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class ApprovalGate {
    private readonly pending = new Map<
        string,
        { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void; timer?: NodeJS.Timeout }
    >();
    private counter = 0;

    constructor(private readonly deps: ApprovalGateDeps) {}

    /** 工具一侧调用：挂起直到有人做出决定 */
    request(input: { toolName: string; args?: unknown; approvalId?: string }): Promise<ApprovalDecision> {
        const at = this.deps.now?.() ?? Date.now();
        const approvalId = input.approvalId ?? `ap-${at.toString(36)}-${++this.counter}`;
        const request: ApprovalRequest = {
            approvalId,
            toolName: input.toolName,
            ...(input.args === undefined ? {} : { args: input.args }),
            at,
        };

        const promise = new Promise<ApprovalDecision>((resolve) => {
            const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => this.settle(approvalId, { approved: false, reason: '等待审批超时' }), timeoutMs)
                    : undefined;
            this.pending.set(approvalId, { request, resolve, ...(timer === undefined ? {} : { timer }) });
        });

        this.deps.request(request);
        return promise;
    }

    /** 用户的决定（HTTP 端点调它）；返回是否命中一个待审批请求 */
    resolve(approvalId: string, decision: ApprovalDecision): boolean {
        return this.settle(approvalId, decision);
    }

    /** 取消这一轮：所有挂起的审批按拒绝收尾，run 才能退出 */
    cancelAll(reason = '本轮已取消'): void {
        for (const approvalId of [...this.pending.keys()]) this.settle(approvalId, { approved: false, reason });
    }

    pendingCount(): number {
        return this.pending.size;
    }

    /** 还在等的请求（刷新 / 重连时恢复审批条用） */
    list(): ApprovalRequest[] {
        return [...this.pending.values()].map((entry) => entry.request);
    }

    private settle(approvalId: string, decision: ApprovalDecision): boolean {
        const entry = this.pending.get(approvalId);
        if (entry === undefined) return false;
        this.pending.delete(approvalId);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        this.deps.settle(entry.request, decision);
        entry.resolve(decision);
        return true;
    }
}
