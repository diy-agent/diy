// @vitest-environment happy-dom
//
// tests/block-renderers.dom.test.ts — tool / think 块的**渲染行为**（##514 前置）。
//
// 判据（用户 2026-11-03）：
//   ① state=running ⇒ `<details open>`（跑的时候能看进度）
//   ② state=ok / error ⇒ 收起
//   ③ `data-state` 落在 `<details>` 与圆点上（CSS 靠它上色：黄 / 绿 / 红）
// 另测 think 块（done 前展开、done 后收起）与 /demo-tool 的演示数据，
// 保证「手点 /demo-tool 看到的效果」和单测断言的是同一份数据。

import { describe, expect, it } from 'vitest';
import { renderBlock } from '../src/block-renderers.js';
import { DEMO_TOOL_COMMAND, demoToolMessage } from '../src/demo.js';
import type { Block } from '../src/shared.js';

const tool = (state: 'running' | 'ok' | 'error', extra: Record<string, unknown> = {}): Block => ({
    kind: 'tool',
    id: 'tool-1',
    data: { name: 'read_file', args: 'a.md', state, ...extra },
});

describe('tool 块渲染', () => {
    it('① running ⇒ details 展开，圆点 data-state=running（黄）', () => {
        const el = renderBlock(tool('running')) as HTMLDetailsElement;
        expect(el.open).toBe(true);
        expect(el.dataset['state']).toBe('running');
        expect(el.querySelector('.chat-tool-dot')?.getAttribute('data-state')).toBe('running');
        expect(el.querySelector('summary')?.textContent).toContain('read_file');
        expect(el.querySelector('summary')?.textContent).toContain('a.md');
    });

    it('② ok ⇒ 收起；③ data-state=ok（绿）+ 摘要可见', () => {
        const el = renderBlock(tool('ok', { summary: '读取 6.0 KB' })) as HTMLDetailsElement;
        expect(el.open).toBe(false);
        expect(el.dataset['state']).toBe('ok');
        expect(el.querySelector('.chat-tool-dot')?.getAttribute('data-state')).toBe('ok');
        expect(el.querySelector('.chat-tool-summary')?.textContent).toBe('读取 6.0 KB');
    });

    it('② error ⇒ 收起；③ data-state=error（红）', () => {
        const el = renderBlock(tool('error', { summary: '文件不存在' })) as HTMLDetailsElement;
        expect(el.open).toBe(false);
        expect(el.dataset['state']).toBe('error');
        expect(el.querySelector('.chat-tool-dot')?.getAttribute('data-state')).toBe('error');
        expect(el.querySelector('.chat-tool-summary')?.textContent).toBe('文件不存在');
    });

    it('输出只在有 output 时出现（折叠区里）', () => {
        const withOut = renderBlock(tool('ok', { output: '行 1\n行 2' })) as HTMLElement;
        expect(withOut.querySelector('.chat-tool-output')?.textContent).toBe('行 1\n行 2');
        const without = renderBlock(tool('ok')) as HTMLElement;
        expect(without.querySelector('.chat-tool-output')).toBeNull();
    });
});

describe('think 块渲染', () => {
    it('没 done ⇒ 展开显示「思考中…」', () => {
        const el = renderBlock({ kind: 'think', id: 't1', data: { text: '在想…' } }) as HTMLDetailsElement;
        expect(el.open).toBe(true);
        expect(el.querySelector('summary')?.textContent).toBe('思考中…');
    });

    it('done ⇒ 收起，标题变「思考」', () => {
        const el = renderBlock({ kind: 'think', id: 't1', data: { text: '想完了', done: true } }) as HTMLDetailsElement;
        expect(el.open).toBe(false);
        expect(el.querySelector('summary')?.textContent).toBe('思考');
    });
});

describe('/demo-tool 演示数据（手点看到的就是这两段）', () => {
    it('命令常量对得上输入框里敲的', () => {
        expect(DEMO_TOOL_COMMAND).toBe('/demo-tool');
    });

    it('running 段 = 展开的黄点；ok 段 = 收起的绿点 + 摘要 + 输出', () => {
        // 2026-11-11：演示消息里多了一个 think 块（AI Elements 的 Reasoning 演示），tool 不再是 blocks[0]
        const toolOf = (m: ReturnType<typeof demoToolMessage>) => m.blocks.find((b) => b.kind === 'tool')!;
        const running = renderBlock(toolOf(demoToolMessage('running'))) as HTMLDetailsElement;
        expect(running.open).toBe(true);
        expect(running.dataset['state']).toBe('running');

        const ok = renderBlock(toolOf(demoToolMessage('ok'))) as HTMLDetailsElement;
        expect(ok.open).toBe(false);
        expect(ok.dataset['state']).toBe('ok');
        expect(ok.querySelector('.chat-tool-summary')?.textContent).toBe('读取 6.0 KB');
        expect(ok.querySelector('.chat-tool-output')?.textContent).toContain('演示输出');
    });
});
