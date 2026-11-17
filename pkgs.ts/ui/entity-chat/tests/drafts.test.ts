import { afterEach, describe, expect, it, vi } from 'vitest';

import { DraftStore, dialogOwner, hasDraftContent } from '../src/drafts';

interface Call {
    url: string;
    method: string;
    body?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

/** 默认 GET /drafts 返回空；PUT/DELETE 返回 ok */
function makeStore(handler?: (call: Call) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const call: Call = {
            url: String(input),
            method: init?.method ?? 'GET',
            ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        };
        calls.push(call);
        if (handler !== undefined) return handler(call);
        if (call.method === 'GET') return jsonResponse({ drafts: [] });
        return jsonResponse({ ok: true, updatedAt: 1 });
    }) as typeof fetch;
    const store = new DraftStore({ fetchImpl, debounceMs: 600, retryBaseMs: 1_000 });
    return { store, calls };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('DraftStore', () => {
    it('输入防抖写入：600ms 内只发一次 PUT，内容是 { text }', async () => {
        vi.useFakeTimers();
        const { store, calls } = makeStore();
        store.setText('proj:a', 'composer', '打');
        store.setText('proj:a', 'composer', '打到一半');
        expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(600);
        const puts = calls.filter((call) => call.method === 'PUT');
        expect(puts).toHaveLength(1);
        expect(puts[0]?.url).toBe('/api/rooms/proj%3Aa/drafts/composer');
        expect(JSON.parse(puts[0]?.body ?? '{}')).toEqual({ value: { text: '打到一半' } });
        expect(store.statusOf('proj:a')).toBe('saved');
    });

    it('清空立即 DELETE（不防抖），✎ 跟着灭', async () => {
        vi.useFakeTimers();
        const { store, calls } = makeStore();
        store.setText('proj:a', 'composer', '一句话');
        expect(store.hasDraft('proj:a')).toBe(true);

        store.clear('proj:a', 'composer');
        await vi.advanceTimersByTimeAsync(0);
        expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
        expect(store.hasDraft('proj:a')).toBe(false);
        expect(store.textOf('proj:a', 'composer')).toBe('');
    });

    it('加载服务端草稿；本地已经打了一半时不被旧值覆盖', async () => {
        let release: ((value: Response) => void) | undefined;
        const gate = new Promise<Response>((resolve) => {
            release = resolve;
        });
        const { store } = makeStore((call) => (call.method === 'GET' ? gate : jsonResponse({ ok: true })));

        const loading = store.ensure('proj:a');
        store.setText('proj:a', 'composer', '本地正在打');
        release?.(jsonResponse({ drafts: [{ field: 'composer', value: { text: '服务端旧值' }, updatedAt: 1 }] }));
        await loading;

        expect(store.textOf('proj:a', 'composer')).toBe('本地正在打');
    });

    it('没输入过时加载回填服务端草稿', async () => {
        const { store } = makeStore((call) =>
            call.method === 'GET'
                ? jsonResponse({ drafts: [{ field: 'composer', value: { text: '上次没发' }, updatedAt: 1 }] })
                : jsonResponse({ ok: true }),
        );
        await store.ensure('proj:a');
        expect(store.textOf('proj:a', 'composer')).toBe('上次没发');
        expect(store.hasDraft('proj:a')).toBe(true);
    });

    it('clearIfMatches 只清"还是我发出去那版"的草稿', () => {
        const { store } = makeStore();
        store.setText('proj:a', 'composer', '发出去这句');
        store.clearIfMatches('proj:a', 'composer', '别的');
        expect(store.textOf('proj:a', 'composer')).toBe('发出去这句');
        store.clearIfMatches('proj:a', 'composer', '发出去这句');
        expect(store.textOf('proj:a', 'composer')).toBe('');
    });

    it('写失败保留内容并退避重试，成功后状态回到 saved', async () => {
        vi.useFakeTimers();
        let puts = 0;
        const { store } = makeStore((call) => {
            if (call.method !== 'PUT') return jsonResponse({ drafts: [] });
            puts += 1;
            if (puts === 1) throw new Error('offline');
            return jsonResponse({ updatedAt: 2 });
        });

        store.setText('proj:a', 'composer', '别丢');
        await vi.advanceTimersByTimeAsync(600);
        expect(store.statusOf('proj:a')).toBe('error');
        expect(store.textOf('proj:a', 'composer')).toBe('别丢');

        await vi.advanceTimersByTimeAsync(1_000);
        expect(puts).toBe(2);
        expect(store.statusOf('proj:a')).toBe('saved');
    });

    it('clearIfValueMatches：按值比较（键顺序无关），改过的留着', () => {
        const { store } = makeStore();
        const submitted = { selected: ['a'], fields: {}, text: '' };
        store.setValue('proj:a', 'ask:1', submitted);

        store.clearIfValueMatches('proj:a', 'ask:1', { text: '', fields: {}, selected: ['a'] });
        expect(store.valueOf('proj:a', 'ask:1')).toBeUndefined();

        store.setValue('proj:a', 'ask:2', { selected: ['a'], fields: {}, text: '又改了' });
        store.clearIfValueMatches('proj:a', 'ask:2', submitted);
        expect(store.valueOf('proj:a', 'ask:2')).toEqual({ selected: ['a'], fields: {}, text: '又改了' });
    });

    it('一条草稿值变得没内容时，✎ 跟着灭（不用等 DELETE 回来）', () => {
        const { store } = makeStore();
        store.setValue('proj:a', 'ask:1', { selected: ['a'], fields: {}, text: '' });
        expect(store.hasDraft('proj:a')).toBe(true);
        store.setValue('proj:a', 'ask:1', { selected: [], fields: {}, text: '' });
        expect(store.hasDraft('proj:a')).toBe(false);
    });

    it('不知道房间（owner 为空）时只存内存，不请求 /rooms//drafts', async () => {
        const { store, calls } = makeStore();
        store.setValue('', 'ask:1', { text: '半填' });
        await store.flush('');
        expect(calls).toHaveLength(0);
        expect(store.valueOf('', 'ask:1')).toEqual({ text: '半填' });
    });

    it('seed 的 hasDraft 给侧栏初始值；本端改过的 owner 不被后续 seed 覆盖', () => {
        const { store } = makeStore();
        store.seed([{ id: 'proj:a', hasDraft: true }, { id: 'proj:b', hasDraft: false }]);
        expect(store.hasDraft('proj:a')).toBe(true);
        expect(store.hasDraft('proj:b')).toBe(false);

        store.setText('proj:b', 'composer', '新输入');
        store.seed([{ id: 'proj:b', hasDraft: false }]);
        expect(store.hasDraft('proj:b')).toBe(true);
    });

    it('对话框草稿走 /drafts/:owner（synthetic scope），不冒充房间', async () => {
        vi.useFakeTimers();
        const { store, calls } = makeStore();
        const owner = dialogOwner('create-task', 'proj:diy');
        expect(owner).toBe('dlg:create-task:proj:diy');

        store.setText(owner, 'desc', '要做到什么程度算完成…');
        await vi.advanceTimersByTimeAsync(600);
        const put = calls.find((call) => call.method === 'PUT');
        // 房间草稿是 /rooms/:id/drafts；对话框没有实体 id，不能请求一个不存在的房间
        expect(put?.url).toBe('/api/drafts/dlg%3Acreate-task%3Aproj%3Adiy/desc');

        store.clear(owner, 'desc');
        await vi.advanceTimersByTimeAsync(0);
        expect(calls.at(-1)?.method).toBe('DELETE');
        expect(calls.at(-1)?.url).toBe('/api/drafts/dlg%3Acreate-task%3Aproj%3Adiy/desc');
    });

    it('对话框草稿的 ✎ 不落到任何房间上（侧栏说的是"房间里没发出去的东西"）', () => {
        const { store } = makeStore();
        store.setText(dialogOwner('create-task', 'proj:diy'), 'desc', '写了一半');
        expect(store.hasDraft('proj:diy')).toBe(false);
        expect(store.hasDraft(dialogOwner('create-task', 'proj:diy'))).toBe(true);
    });

    it('浏览器里 fetch 的 this 必须是 window 或 undefined，否则 Illegal invocation', async () => {
        vi.useFakeTimers();
        // 模拟浏览器：fetch 只接受 this === window（这里用 globalThis 代替）或裸调时的 undefined，
        // 当成别的对象的方法调就抛 Illegal invocation。store 无论是 bind 到 globalThis 还是裸调都过，
        // 但少了这两下防护（store 直接 `this.doFetch(...)` 且没 bind）就会红。
        const strictFetch = function (this: unknown, _input: RequestInfo | URL, init?: RequestInit) {
            if (this !== undefined && this !== globalThis) {
                throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
            }
            const method = init?.method ?? 'GET';
            return Promise.resolve(method === 'GET' ? jsonResponse({ drafts: [] }) : jsonResponse({ ok: true }));
        } as unknown as typeof fetch;
        const store = new DraftStore({ fetchImpl: strictFetch, debounceMs: 600 });

        store.setText('proj:a', 'composer', '一句话');
        await vi.advanceTimersByTimeAsync(600);

        expect(store.statusOf('proj:a')).toBe('saved');
    });

    it('空内容判定：空格 / 空对象 / 全空对象都不算草稿', () => {
        expect(hasDraftContent({ text: '   ' })).toBe(false);
        expect(hasDraftContent({ text: '' })).toBe(false);
        expect(hasDraftContent({ fields: { a: '' } })).toBe(false);
        expect(hasDraftContent({ selected: [] })).toBe(false);
        expect(hasDraftContent({ text: 'x' })).toBe(true);
        expect(hasDraftContent({ selected: ['a'] })).toBe(true);
    });
});
