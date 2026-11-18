// poll.test.ts —— 「别的房间有新消息」靠 30s 轮询补上，但只在页面可见时拉。
//
// 这条容易写出两个 bug，都在这测：
//   1. 后台标签页也在每 30s 打接口（白耗，而且没人看）；
//   2. 切回可见时不补一次（用户看着的是 30s 之前的数据，最长等半分钟才刷新）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = () => void;

const handlers = new Map<string, Handler>();
let calls: string[] = [];

/** 环境替身：store 只在函数里做 `typeof window !== 'undefined'` 检查，所以这时挂得上 */
function installFakeEnv(visibility: 'visible' | 'hidden'): void {
    const documentStub = {
        visibilityState: visibility,
        addEventListener: (type: string, handler: Handler) => handlers.set(`document:${type}`, handler),
    };
    const windowStub = {
        addEventListener: (type: string, handler: Handler) => handlers.set(`window:${type}`, handler),
        location: { pathname: '/' },
        history: { replaceState: () => undefined, pushState: () => undefined },
    };
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', windowStub);
}

beforeEach(() => {
    handlers.clear();
    calls = [];
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (input: string) => {
        calls.push(String(input));
        return { ok: true, json: async () => [] };
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
});

/** 每个用例重新 import 一份干净的 store（模块级 pollTimer / state 都要重置） */
async function bootstrap(): Promise<typeof import('../src/store')> {
    const store = await import('../src/store');
    store.actions.bootstrap();
    // 把首屏那次 refresh 的微任务跑完（/rooms + /bots 各一次）
    await vi.advanceTimersByTimeAsync(0);
    return store;
}

describe('房间列表轮询', () => {
    it('可见时每 30s 拉一次（/rooms + /bots）', async () => {
        installFakeEnv('visible');
        await bootstrap();
        expect(calls).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls).toHaveLength(4);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls).toHaveLength(6);
    });

    it('不可见时不拉（后台标签页不白打接口）', async () => {
        installFakeEnv('hidden');
        await bootstrap();
        expect(calls).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(90_000);
        expect(calls).toHaveLength(2);
    });

    it('切回可见立刻补一次，不用等下一个整周期', async () => {
        installFakeEnv('visible');
        await bootstrap();
        expect(calls).toHaveLength(2);

        // 模拟切到后台再切回来：visibilitychange handler 被调用
        const document = globalThis.document as unknown as { visibilityState: string };
        document.visibilityState = 'hidden';
        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls).toHaveLength(2);

        document.visibilityState = 'visible';
        handlers.get('document:visibilitychange')?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(4);
    });

    it('轮询成功不抹掉用户还没看到的错误（改名失败和「服务端在不在」无关）', async () => {
        installFakeEnv('visible');
        const store = await bootstrap();

        // 制造一条该被用户看到的错误
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }));
        await store.actions.renameRoom('proj:diy', '新名字');
        expect(store.shellSnapshot().error).toContain('改名失败');

        // 轮询成功后它仍在：轮询只刷列表，不该替用户「点掉」错误条
        vi.stubGlobal('fetch', async (input: string) => ({
            ok: true,
            json: async () => (String(input).includes('/bots') ? [] : []),
        }));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(store.shellSnapshot().error).toContain('改名失败');
    });

    it('轮询失败不写 error、也不停止轮询（后端重启别每 30s 弹一条）', async () => {
        installFakeEnv('visible');
        const store = await bootstrap();
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 502, json: async () => ({}) }));

        await vi.advanceTimersByTimeAsync(60_000);
        expect(store.shellSnapshot().error).toBeUndefined();
        // 轮询自身仍在（失败没把计时器打断）
        calls = [];
        vi.stubGlobal('fetch', async (input: string) => {
            calls.push(String(input));
            return { ok: true, json: async () => [] };
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls).toHaveLength(2);
    });
});
