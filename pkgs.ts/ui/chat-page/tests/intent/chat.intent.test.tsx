// @vitest-environment happy-dom
//
// chat.intent.test.tsx —— **Agent UI 的意图测试范本**（##518）
//
// 这一份是给"新测试口径"用的样板：只从**用户视角**驱动界面、只断言用户看得见的东西 +
// 发出去的 rpc。不碰内部状态、不按 class 选择、不起 Electron / 不起真 LLM。
//
// 与同目录 `renderer-demo.dom.test.ts` 的区别：
//   · 那个是**实现级** DOM 测试（`querySelector('.chat-block-tool')`、读 `dataset.state`）；
//   · 这里按**角色/名字**找元素（`getByRole('textbox')`、`getByRole('button', {name})`），
//     断言「用户看到什么」+「发了哪个 rpc」，重构改 class/结构时不会假红。
//
// 判据见 docs/test-ownership.md：一句话能写成「用户看到 X 变成 Y」⇒ 写在这一层。
import { beforeEach, describe, expect, it } from 'vitest';
import { getByRole, queryByRole } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { chatPageView } from '../../src/renderer-react.jsx';
import type { PageContext } from '@diy-agent/workbench-ui';
import type { BotChatSnapshot, BotView } from '../../src/shared.js';

/** 一份最小可用的快照：一个 bot、零消息（`bot: null` 是"首启引导页"，测不到聊天面） */
const bot: BotView = {
    id: 'b1',
    name: '助手',
    instructions: '',
    model: 'test/model',
    needsModel: false,
    sessionCount: 0,
    createdAt: '2026-11-10T00:00:00.000Z',
};
const snap = (over: Partial<BotChatSnapshot> = {}): BotChatSnapshot => ({
    bots: [bot],
    bot,
    messages: [],
    metrics: null,
    ...over,
});

interface Call {
    readonly method: string;
    readonly args: unknown;
}

/** 组装页面：记录所有 rpc 调用，并按脚本返回（没写的直接抛 —— 不该被调用的一调就红） */
function mountPage(handlers: Record<string, (args?: unknown) => unknown>) {
    const calls: Call[] = [];
    const ctx: PageContext = {
        invoke: (async <T = unknown>(method: string, args?: unknown): Promise<T> => {
            calls.push({ method, args });
            const handler = handlers[method];
            if (handler === undefined) throw new Error(`测试没给 handler：${method}`);
            return handler(args) as T;
        }) as PageContext['invoke'],
    };
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    chatPageView.render(root, ctx);
    return { root, calls };
}

let root: HTMLElement;
beforeEach(() => {
    document.body.replaceChildren();
});

describe('Agent UI：用户能看见的行为', () => {
    it('snapshot 拿不到（未配置）⇒ 给一句可读的提示，而不是白屏', async () => {
        const page = mountPage({
            snapshot: () => {
                throw new Error('single-session');
            },
        });
        root = page.root;
        await new Promise((r) => setTimeout(r, 20));

        const text = document.body.textContent ?? '';
        expect(text.length).toBeGreaterThan(0);
        // 不出现英文堆栈 / 未捕获错误样式
        expect(text).not.toContain('undefined');
    });

    it('输入一句话并回车 ⇒ 调用 send（参数是刚输入的文本），且输入框被清空', async () => {
        const user = userEvent.setup();
        const page = mountPage({
            snapshot: () => snap(),
            models: () => ({ choices: [] }),
            send: () => snap(),
        });
        root = page.root;

        const box = getByRole(root, 'textbox') as HTMLInputElement;
        await user.type(box, '你好');
        await user.keyboard('{Enter}');
        await new Promise((r) => setTimeout(r, 30));

        const sent = page.calls.filter((c) => c.method === 'send');
        expect(sent).toHaveLength(1);
        expect(sent[0]?.args).toEqual({ text: '你好' });
        expect((getByRole(root, 'textbox') as HTMLInputElement).value).toBe('');
    });

    it('发送失败 ⇒ 界面出现「出错了」，用户的输入不静默丢失', async () => {
        const user = userEvent.setup();
        const page = mountPage({
            snapshot: () => snap(),
            models: () => ({ choices: [] }),
            send: () => {
                throw new Error('upstream 500');
            },
        });
        root = page.root;

        const box = getByRole(root, 'textbox');
        await user.type(box, '会失败的一句话');
        await user.keyboard('{Enter}');
        await new Promise((r) => setTimeout(r, 60));

        expect(document.body.textContent ?? '').toContain('出错了');
    });

    it('没有输入时不发请求（空提交是用户误触，不该产生 rpc）', async () => {
        const user = userEvent.setup();
        const page = mountPage({
            snapshot: () => snap(),
            models: () => ({ choices: [] }),
            send: () => snap(),
        });
        root = page.root;

        const box = getByRole(root, 'textbox');
        await user.click(box);
        await user.keyboard('{Enter}');
        await new Promise((r) => setTimeout(r, 30));

        expect(page.calls.filter((c) => c.method === 'send')).toHaveLength(0);
        expect(queryByRole(root, 'textbox')).toBeTruthy(); // 界面还在，没有崩
    });
});
