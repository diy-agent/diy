// approval.test.ts —— 工具审批闸门：挂起 / 批准 / 拒绝 / 取消 / 超时。

import { describe, expect, it } from 'vitest';

import { ApprovalGate, type ApprovalDecision } from '../src/approval';
import type { ApprovalRequest } from '../src/types';

function makeGate(options: { timeoutMs?: number } = {}) {
    const requests: ApprovalRequest[] = [];
    const settled: Array<{ request: ApprovalRequest; decision: ApprovalDecision }> = [];
    const gate = new ApprovalGate({
        request: (request) => requests.push(request),
        settle: (request, decision) => settled.push({ request, decision }),
        timeoutMs: options.timeoutMs ?? 0,
    });
    return { gate, requests, settled };
}

describe('ApprovalGate', () => {
    it('请求挂起直到有人决定；批准后继续', async () => {
        const h = makeGate();
        const pending = h.gate.request({ toolName: 'bash', args: { command: 'ls' } });

        expect(h.gate.pendingCount()).toBe(1);
        expect(h.requests[0]?.toolName).toBe('bash');

        const hit = h.gate.resolve(h.requests[0]!.approvalId, { approved: true });
        expect(hit).toBe(true);
        await expect(pending).resolves.toEqual({ approved: true });
        expect(h.settled[0]?.decision.approved).toBe(true);
        expect(h.gate.pendingCount()).toBe(0);
    });

    it('拒绝：同样解决，reason 带回去', async () => {
        const h = makeGate();
        const pending = h.gate.request({ toolName: 'write' });
        h.gate.resolve(h.requests[0]!.approvalId, { approved: false, reason: '别动这个文件' });

        await expect(pending).resolves.toEqual({ approved: false, reason: '别动这个文件' });
    });

    it('未知 approvalId：返回 false，不影响已有请求', () => {
        const h = makeGate();
        void h.gate.request({ toolName: 'bash' });
        expect(h.gate.resolve('nope', { approved: true })).toBe(false);
        expect(h.gate.pendingCount()).toBe(1);
    });

    it('cancelAll：所有挂起的请求按拒绝收尾（run 才能退出）', async () => {
        const h = makeGate();
        const a = h.gate.request({ toolName: 'bash' });
        const b = h.gate.request({ toolName: 'edit' });

        h.gate.cancelAll('本轮已取消');

        await expect(a).resolves.toMatchObject({ approved: false, reason: '本轮已取消' });
        await expect(b).resolves.toMatchObject({ approved: false });
        expect(h.gate.pendingCount()).toBe(0);
    });

    it('超时：按拒绝处理并标记原因', async () => {
        const h = makeGate({ timeoutMs: 10 });
        const pending = h.gate.request({ toolName: 'bash' });

        await expect(pending).resolves.toMatchObject({ approved: false, reason: '等待审批超时' });
        expect(h.gate.pendingCount()).toBe(0);
    });
});
