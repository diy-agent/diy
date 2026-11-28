import { afterEach, describe, expect, it, vi } from 'vitest';

import { draftFieldOf } from '../src/askDraft';
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
    const pathOf = (owner: string): string => {
        const id = encodeURIComponent(owner);
        return owner.startsWith('dlg:') ? `/api/drafts/${id}` : `/api/rooms/${id}/drafts`;
    };
    const run = async (call: Call): Promise<Response> => {
        calls.push(call);
        if (handler !== undefined) return handler(call);
        if (call.method === 'GET') return jsonResponse({ drafts: [] });
        return jsonResponse({ ok: true, updatedAt: 1 });
    };
    const check = async (call: Call): Promise<unknown> => {
        const response = await run(call);
        if (!response.ok) throw new Error(`草稿保存失败：HTTP ${response.status}`);
        return response.json();
    };
    const store = new DraftStore({ debounceMs: 600, retryBaseMs: 1_000 });
    store.configure({
        list: async (owner) =>
            (await check({ url: pathOf(owner), method: 'GET' })) as {
                drafts?: Array<{ field: string; value: unknown; updatedAt: number }>;
            },
        put: async (owner, field, value) => {
            await check({
                url: `${pathOf(owner)}/${encodeURIComponent(field)}`,
                method: 'PUT',
                body: JSON.stringify({ value }),
            });
            return { updatedAt: 1 };
        },
        remove: async (owner, field) => {
            await check({ url: `${pathOf(owner)}/${encodeURIComponent(field)}`, method: 'DELETE' });
            return {};
        },
    });
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

    it('发送后在途的旧 GET 不能把已清的草稿灌回来（竞态：偶尔没清空）', async () => {
        // 复现用户 2026-11-28「发送后输入框偶尔没清空」：
        // 打开房间发起 ensure()（GET 在途），期间用户把草稿发出去并 clear（DELETE 成功），
        // 此时 GET 才带着发送前的旧草稿返回 —— 旧值不能被灌回，否则输入框又冒出刚发的那条。
        let release: ((value: Response) => void) | undefined;
        const gate = new Promise<Response>((resolve) => {
            release = resolve;
        });
        const { store } = makeStore((call) => (call.method === 'GET' ? gate : jsonResponse({ ok: true })));

        // ensure 发出 GET 但故意不返回
        const loading = store.ensure('proj:a');
        // GET 在途期间，用户有内容并发送成功 → clear
        store.setText('proj:a', 'composer', '发出去这句');
        store.clearIfMatches('proj:a', 'composer', '发出去这句');
        expect(store.textOf('proj:a', 'composer')).toBe('');

        // GET 这时才返回发送前的旧草稿
        release?.(jsonResponse({ drafts: [{ field: 'composer', value: { text: '发出去这句' }, updatedAt: 1 }] }));
        await loading;

        expect(store.textOf('proj:a', 'composer')).toBe('');
    });

    it('连续 10 次「发送后立即输入」：已发的被清、新打的字都留着', () => {
        // 用户验收口径：发送后立即再输入，输入框要保留用户新打的字（不是被清空、也不是旧字残留）。
        const { store } = makeStore();
        for (let i = 0; i < 10; i += 1) {
            const sent = `发出去第${i}句`;
            store.setText('proj:a', 'composer', sent);
            // 模拟发送成功：clear 用 trim 后的 sent
            store.clearIfMatches('proj:a', 'composer', sent.trim());
            expect(store.textOf('proj:a', 'composer')).toBe('');
            // 用户立刻打下一句（还没到下一次发送）
            store.setText('proj:a', 'composer', `新打第${i}句`);
            expect(store.textOf('proj:a', 'composer')).toBe(`新打第${i}句`);
            // 若此时上一次的 clear 迟到，也不能误清新字
            store.clearIfMatches('proj:a', 'composer', sent.trim());
            expect(store.textOf('proj:a', 'composer')).toBe(`新打第${i}句`);
        }
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
        store.setValue('proj:a', 'desc', { text: '写了一半' });
        expect(store.hasDraft('proj:a')).toBe(true);
        store.setValue('proj:a', 'desc', { text: '   ' });
        expect(store.hasDraft('proj:a')).toBe(false);
    });

    it('提问填了一半不算 ✎：那是行上 ? 的事（卡片本来就在时间线上）', () => {
        const { store } = makeStore();
        store.setValue('proj:a', draftFieldOf('ask_1'), { selected: ['a'], fields: {}, text: '' });
        // 打开过这个房间、草稿在内存里也不亮
        expect(store.hasDraft('proj:a')).toBe(false);
        // 发言框同时有字时才亮
        store.setText('proj:a', 'composer', '还没发');
        expect(store.hasDraft('proj:a')).toBe(true);
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
        store.seed([
            { id: 'proj:a', hasDraft: true },
            { id: 'proj:b', hasDraft: false },
        ]);
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

    it('空内容判定：空格 / 空对象 / 全空对象都不算草稿', () => {
        expect(hasDraftContent({ text: '   ' })).toBe(false);
        expect(hasDraftContent({ text: '' })).toBe(false);
        expect(hasDraftContent({ fields: { a: '' } })).toBe(false);
        expect(hasDraftContent({ selected: [] })).toBe(false);
        expect(hasDraftContent({ text: 'x' })).toBe(true);
        expect(hasDraftContent({ selected: ['a'] })).toBe(true);
    });
});
