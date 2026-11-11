// @vitest-environment happy-dom
//
// tests/renderer-demo.dom.test.ts — `/demo-tool` 的**端到端**（真 renderer + 真 DOM；##526 起 = React 版）：
// 在输入框里敲 `/demo-tool` 回车 ⇒ 出现一条 tool 块（running、展开、黄点）
// ⇒ 约 900ms 后原地变 ok（收起、绿点、摘要 + 输出）。全程不碰主进程（假 gateway 只回 snapshot 失败）。
//
// 这是 ##514 接真工具调用之前的「手点复现用例」的单测版；真窗口里同样能敲（见 verify-render）。

import { beforeEach, describe, expect, it } from 'vitest';
import { chatPageView } from '../src/renderer-react.jsx';
import { DEMO_TOOL_COMMAND } from '../src/demo.js';
import type { PageContext } from '@diy-agent/workbench-ui';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 往受控输入框里「打字」。
 * ##526：输入框是 React 受控组件 —— 直接赋 `input.value` 不会让 React 的 state 跟着变
 * （提交时读到的是空串）。必须走原生 setter + `input` 事件，跟真用户敲键同一条路。
 */
function typeInto(input: HTMLInputElement, text: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}


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
        typeInto(input, DEMO_TOOL_COMMAND);
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        // ##526：React 的更新是异步批处理的（不在 act 里也算）—— 等一个宏任务再看 DOM
        await sleep(0);

        // 2026-11-11：tool 块的渲染换成 AI Elements 的 Tool（Base UI Collapsible）——
        // 断言口径跟随：找包含工具名的折叠容器，看状态徽章的文案。
        const toolRow = (): Element | undefined =>
            [...root.querySelectorAll('[data-slot="collapsible"]')].find((el) => el.textContent?.includes('read_file'));

        // ① 立刻：一条 user + 一条 tool；tool 在跑（状态徽章 Running）
        expect(toolRow()?.textContent).toContain('Running');
        // 演示消息不进核心层：输入框被清空，且没有「出错了」
        expect(input.value).toBe('');
        expect(root.textContent).not.toContain('出错了');

        // ② 900ms 后：同一位置变 ok（Completed + 输出可见）
        await sleep(1_100);
        expect(toolRow()?.textContent).toContain('Completed');
        // 收起态看不到输出（Base UI Panel 关闭时不渲染内容）—— 点开再看
        (toolRow()?.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement | null)?.click();
        await sleep(0);
        expect(toolRow()?.textContent).toContain('演示输出');
    });

    it('普通文本不会被当成命令（照常走 send，报错显示在消息线里）', async () => {
        const input = root.querySelector<HTMLInputElement>('.chat-input')!;
        const form = root.querySelector<HTMLFormElement>('.chat-composer')!;
        typeInto(input, '普通一句话');
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await sleep(50);
        expect([...root.querySelectorAll('[data-slot="collapsible"]')].some((el) => el.textContent?.includes('read_file'))).toBe(false);
        expect(root.textContent).toContain('出错了');
    });
});
