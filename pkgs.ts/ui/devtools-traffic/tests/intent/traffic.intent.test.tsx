// @vitest-environment happy-dom
//
// traffic.intent.test.tsx —— raw request log 插件的意图测试（##518 第一个 devtools 插件）
//
// 测用户看得到的行为：列表渲染成什么样、查询带什么参数、点一行看到什么。
// 不启动 app、不读真磁盘日志 —— 宿主能力只有一个 `invoke`，测试里换成脚本化实现，
// 同时把每次调用记下来（`calls`）就是「插件发了哪些 rpc」的契约。
import { beforeEach, describe, expect, it } from 'vitest';
import { getByRole, getAllByRole, queryByText } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { trafficPageView } from '../../src/renderer-react.js';

interface Call {
    readonly method: string;
    readonly args: unknown;
}

function mount(handlers: Record<string, (args?: unknown) => unknown>) {
    const calls: Call[] = [];
    const ctx = {
        invoke: (async <T = unknown>(method: string, args?: unknown): Promise<T> => {
            calls.push({ method, args });
            const handler = handlers[method];
            if (handler === undefined) throw new Error(`测试没给 handler：${method}`);
            return handler(args) as T;
        }) as never,
    };
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    trafficPageView.render(root, ctx as never);
    return { root, calls };
}

const row = (over: Record<string, unknown> = {}) => ({
    at: '2026-11-10T10:00:00.000Z',
    kind: 'llm',
    method: 'POST',
    url: 'https://api.example.com/v1/chat',
    model: 'test/model',
    status: 200,
    ms: 1234,
    ...over,
});

const emptyQuery = () => ({ records: [], scanned: 0, files: [], hits: 0, truncated: false, ms: 1 });

beforeEach(() => {
    document.body.replaceChildren();
});

describe('raw request log：用户能看见的行为', () => {
    it('挂载即查一次 ⇒ 列表按「时间 / 方法 / 状态 / 地址或模型 / 耗时」显示每一行', async () => {
        const page = mount({ query: () => ({ ...emptyQuery(), records: [row()], hits: 1, scanned: 1 }) });
        await new Promise((r) => setTimeout(r, 80));

        expect(page.calls.filter((c) => c.method === 'query')).toHaveLength(1);
        const table = getByRole(page.root, 'table');
        expect(table.textContent).toContain('test/model');
        expect(table.textContent).toContain('200');
        expect(table.textContent).toContain('1234 ms');
    });

    it('输入关键词提交 ⇒ 带上 text 再查一次；清空后不再带 text', async () => {
        const user = userEvent.setup();
        const page = mount({ query: () => emptyQuery() });
        await new Promise((r) => setTimeout(r, 80));

        const box = getByRole(page.root, 'textbox', { name: '关键词' });
        await user.type(box, 'timeout');
        await user.click(getByRole(page.root, 'button', { name: '查询' }));
        await new Promise((r) => setTimeout(r, 80));

        const queries = page.calls.filter((c) => c.method === 'query');
        expect(queries).toHaveLength(2);
        expect(queries[1]?.args).toMatchObject({ text: 'timeout' });
    });

    it('点一行 ⇒ 详情面板显示原始记录（JSON），且不动列表', async () => {
        const user = userEvent.setup();
        const page = mount({ query: () => ({ ...emptyQuery(), records: [row({ requestId: 'r-1' })], hits: 1 }) });
        await new Promise((r) => setTimeout(r, 80));

        const rows = getAllByRole(page.root, 'row').filter((r) => r.tagName === 'TR' && r.getAttribute('tabindex') === '0');
        await user.click(rows[0]!);
        await new Promise((r) => setTimeout(r, 80));

        const detail = getByRole(page.root, 'region', { name: '记录详情' });
        expect(detail.textContent).toContain('r-1');
    });

    it('查询失败 ⇒ 顶部给出错误文本，不白屏、不残留旧行', async () => {
        const page = mount({
            query: () => {
                throw new Error('日志目录不可读');
            },
        });
        await new Promise((r) => setTimeout(r, 80));

        expect(page.root.textContent ?? '').toContain('日志目录不可读');
        expect(queryByText(page.root, '（没有匹配的请求）')).toBeTruthy();
    });
});
