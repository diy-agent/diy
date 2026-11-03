// @vitest-environment happy-dom
//
// tests/renderer-demo.dom.test.ts — `/demo-tool` 的**端到端**（真 renderer + 真 DOM）：
// 在输入框里敲 `/demo-tool` 回车 ⇒ 出现一条 tool 块（running、展开、黄点）
// ⇒ 约 900ms 后原地变 ok（收起、绿点、摘要 + 输出）。全程不碰主进程（假 gateway 只回 snapshot 失败）。
//
// 这是 ##514 接真工具调用之前的「手点复现用例」的单测版；真窗口里同样能敲（见 verify-render）。

import { beforeEach, describe, expect, it } from 'vitest';
import { chatPageView } from '../src/renderer.js';
import { DEMO_TOOL_COMMAND } from '../src/demo.js';
import type { PageContext } from '@diy-agent/workbench-ui';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 单会话模式（snapshot 不存在 ⇒ UI 退回最朴素的聊天） */
const ctx: PageContext = {
    // 泛型签名要跟 PageContext.invoke 对齐（它声明的是 `<T = unknown>`，写死 unknown 会类型不兼容）
    invoke: async <T = unknown>(): Promise<T> => {
        throw new Error('single-session');
    },
};

let root: HTMLElement;

beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    chatPageView.render(root, ctx);
});

describe('/demo-tool（端到端）', () => {
    it('敲命令 ⇒ 出现 running 的 tool 块（展开），900ms 后原地变 ok（收起）', async () => {
        const input = root.querySelector<HTMLInputElement>('.chat-input')!;
        const form = root.querySelector<HTMLFormElement>('.chat-composer')!;
        input.value = DEMO_TOOL_COMMAND;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

        // ① 立刻：一条 user + 一条 tool；tool 是 running、details 展开、黄点
        const running = root.querySelector<HTMLDetailsElement>('.chat-block-tool')!;
        expect(running).toBeTruthy();
        expect(running.open).toBe(true);
        expect(running.dataset['state']).toBe('running');
        expect(running.querySelector('.chat-tool-dot')?.getAttribute('data-state')).toBe('running');
        // 演示消息不进核心层：输入框被清空，且没有「出错了」
        expect(input.value).toBe('');
        expect(root.querySelector('.chat-text')?.textContent).not.toContain('出错了');

        // ② 900ms 后：同一位置变 ok（收起、绿点、摘要 + 输出）
        await sleep(1_100);
        const done = root.querySelector<HTMLDetailsElement>('.chat-block-tool')!;
        expect(done.open).toBe(false);
        expect(done.dataset['state']).toBe('ok');
        expect(done.querySelector('.chat-tool-dot')?.getAttribute('data-state')).toBe('ok');
        expect(done.querySelector('.chat-tool-summary')?.textContent).toBe('读取 6.0 KB');
        expect(done.querySelector('.chat-tool-output')?.textContent).toContain('演示输出');
    });

    it('普通文本不会被当成命令（照常走 send，报错显示在消息线里）', async () => {
        const input = root.querySelector<HTMLInputElement>('.chat-input')!;
        const form = root.querySelector<HTMLFormElement>('.chat-composer')!;
        input.value = '普通一句话';
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await sleep(50);
        expect(root.querySelector('.chat-block-tool')).toBeNull();
        expect(root.textContent).toContain('出错了');
    });
});
