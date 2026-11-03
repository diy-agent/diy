// 状态存储接口 + 内存实现。
//
// **判据 4（并发消费）靠这里的 `update` 串行化**：读-改-写必须是一个不可分割的单元，
// 否则两个并发申请都能看到 `status: 'created'`，双双消费成功。内存与文件实现都必须
// 把 `update` 串成一条 promise 链；不要在外面先 read 再 update。

import { HubError } from './errors.js';
import type { DomainId, NodeId, PeerState } from './types.js';

export interface HubStore {
    read(): Promise<PeerState>;
    /**
     * 原子读-改-写：fn 抛错时不落盘；fn 的返回值原样返回。
     * 同一个 store 实例上的 update 严格串行（并发调用排队）。
     */
    update<T>(fn: (state: PeerState) => T | Promise<T>): Promise<T>;
}

export function emptyPeerState(domainId: DomainId, hubNodeId: NodeId): PeerState {
    return { version: 1, domainId, hubNodeId, invitations: [], requests: [], memberships: [] };
}

export function cloneState(state: PeerState): PeerState {
    return structuredClone(state);
}

/** 进程内实现（单测 / 一次性 CLI） */
export class MemoryHubStore implements HubStore {
    private state: PeerState;
    private chain: Promise<unknown> = Promise.resolve();

    constructor(initial?: PeerState) {
        this.state = initial ? cloneState(initial) : emptyPeerState('default', 'diy-unknown');
    }

    async read(): Promise<PeerState> {
        return cloneState(this.state);
    }

    update<T>(fn: (state: PeerState) => T | Promise<T>): Promise<T> {
        const run = this.chain.then(async () => {
            const result = await fn(this.state);
            return result;
        });
        // 链上吞掉错误：一次失败的 update 不该让后续调用全部失败
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }
}

export function assertDomain(state: PeerState, domainId: DomainId): void {
    if (state.domainId !== domainId) {
        throw new HubError('hub/bad-input', `域不匹配：本机是 ${state.domainId}，请求是 ${domainId}`);
    }
}
