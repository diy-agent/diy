// tests/modelVision.test.ts —— 「这个模型看不看得见图」的界面判据
//
// 锁三件事：
//   ① 目录标了 `image` 才算收图（缺省 = 不知道 ⇒ 当不收，与服务端 `acceptsImagesOf` 同口径）
//   ② `firstVisionModelKey` 给得出「换到哪一个」（贴图时的提示要靠它）
//   ③ 拼出来的 key 是 `account@provider/model` 三段式（能被 `parseModelKey` 解回来）

import { describe, expect, it } from 'vitest';

import { acceptsImages, firstVisionModelKey, parseModelKey } from '../src/models';
import type { Provider } from '../src/models';

const PROVIDERS: readonly Provider[] = [
    {
        id: 'acme',
        name: 'Acme',
        api: 'https://acme.example/v1',
        accounts: [
            { name: 'unconfigured', configured: false },
            { name: 'main', configured: true },
        ],
        models: [
            { id: 'text-only', name: 'Text Only', input: ['text'] },
            { id: 'unknown', name: 'Unknown' },
            { id: 'vision', name: 'Vision', input: ['text', 'image'] },
        ],
    },
    {
        id: 'beta',
        name: 'Beta',
        api: 'https://beta.example/v1',
        accounts: [{ name: 'k', configured: true }],
        models: [{ id: 'b-vision', name: 'B Vision', input: ['image'] }],
    },
];

describe('acceptsImages', () => {
    it('标了 image 才算收图；缺省 = 不收（保守）', () => {
        expect(acceptsImages(PROVIDERS, 'main@acme/vision')).toBe(true);
        expect(acceptsImages(PROVIDERS, 'main@acme/text-only')).toBe(false);
        expect(acceptsImages(PROVIDERS, 'main@acme/unknown')).toBe(false);
    });

    it('key 解不出来 / 目录里没有 ⇒ 不收（不是抛错）', () => {
        expect(acceptsImages(PROVIDERS, 'garbage')).toBe(false);
        expect(acceptsImages(PROVIDERS, 'main@acme/nope')).toBe(false);
        expect(acceptsImages([], 'main@acme/vision')).toBe(false);
    });
});

describe('firstVisionModelKey', () => {
    it('返回第一个收图的模型，且用已配 key 的账号', () => {
        const key = firstVisionModelKey(PROVIDERS);
        expect(key).toBe('main@acme/vision');
        // 三段式能被解回来（弹窗/底栏都靠 parseModelKey 认）
        expect(parseModelKey(key ?? '')).toEqual({ account: 'main', provider: 'acme', model: 'vision' });
    });

    it('一个收图的都没有 ⇒ undefined（不猜）', () => {
        const textOnly: Provider[] = [
            {
                id: 'x',
                name: 'X',
                api: 'https://x.example/v1',
                accounts: [{ name: 'a', configured: true }],
                models: [{ id: 'm', name: 'M', input: ['text'] }],
            },
        ];
        expect(firstVisionModelKey(textOnly)).toBeUndefined();
    });
});
