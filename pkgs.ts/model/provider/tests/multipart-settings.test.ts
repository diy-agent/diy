// multipart-settings.test.ts —— provider 真的把 strategy 的协议差异**接线**了
//
// 为什么单独一个文件（2026-11-28）：这条 bug 的本质是「机制建好了但没人调」——
//   · strategy（`strategies/providers/opencode`）里 `multiPartToolContent: true` 写着，
//     连「实测可用」的证据都贴在注释里；
//   · `openAiCompatibleSettingsFor` 也早有单测（strategies.test.ts）；
//   · 但 `createOpenAiCompatible` **从来没调用它** ⇒ `supportsMultiPartToolContent` 一直缺省 false。
// 后果：工具结果里的图（`view_image`）被 ai-sdk 整段 JSON 化成几十 MB 文本，模型以为
// 「只收到了 PNG 原始字节」（用户实测报的 opencode-go「看不了图」）。
//
// 所以这里断言的不是「strategy 的值对不对」（那已有测试），而是**它有没有被传给 SDK**。

import { describe, expect, it, vi } from 'vitest';

/** 捕获 `createOpenAICompatible` 的入参（不建真 provider、不发请求） */
const captured: Array<Record<string, unknown>> = [];

vi.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: (settings: Record<string, unknown>) => {
        captured.push(settings);
        return { chatModel: () => ({}) };
    },
}));

const { createOpenAiCompatible } = await import('../src/openai.js');

function build(baseURL: string): void {
    createOpenAiCompatible({ baseURL, apiKey: 'test-key', model: 'test-model' });
}

describe('createOpenAiCompatible 接线 strategy 的 settings', () => {
    it('opencode 端点 ⇒ supportsMultiPartToolContent: true（工具结果里的图真的发出去）', () => {
        build('https://opencode.ai/inference/go/openai/v1');
        expect(captured.at(-1)?.['supportsMultiPartToolContent']).toBe(true);
    });

    it('opencode zen 端点同样开（zen 与 go 共用策略）', () => {
        build('https://opencode.ai/inference/v1');
        expect(captured.at(-1)?.['supportsMultiPartToolContent']).toBe(true);
    });

    it('别家端点 ⇒ 不传这一项（保持 ai-sdk 缺省的 false，不擅自改变协议行为）', () => {
        build('https://api.example.com/v1');
        expect(captured.at(-1)?.['supportsMultiPartToolContent']).toBeUndefined();
    });
});
