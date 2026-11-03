// tests/yaml-out.test.ts — 真源落盘的**输出风格**判据（##5 报：单行值落成一行，人改起来整行重排）
//
// 判据不是"看着像块标量"，而是三条可机械验的性质：
//   ① 风格：`value:` / `description:` 后面必须是 `|-`（单行值也一样 —— 同字段永远同形）
//   ② round-trip：`load(dump(x))` **逐字等于** x（含空行、列表、末尾无换行）—— 这是不能
//      靠"补个 \n 骗 js-yaml 选块风格"的原因，那会读回时多一个换行
//   ③ 边界：短 token（id / at / probe）不被拉成块标量（否则真源全是五行的噪音）
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { dumpSource } from '../src/node/yaml-out';
import { renderDoc } from '../src/node/index';
import type { Fact } from '../src/types';

describe('dumpSource（真源风格）', () => {
    it('value / description 一律 `|-` 块标量，单行值也是', () => {
        const text = dumpSource({ facts: { 'a#b': { value: '18888', id: 'x' } }, subjects: { s: { description: '一句话' } } });
        expect(text).toContain('value: |-\n      18888');
        expect(text).toContain('description: |-\n      一句话');
    });

    it('round-trip 精确：空行 / 列表 / 末尾无换行都不增不减', () => {
        const doc = {
            facts: {
                'a#b': { value: '第一段\n\n- 列表\n- 第二项\n\n| 列 |\n|---|\n| 1 |' },
                'c#d': { value: '单行' },
                'e#f': { value: '' },
            },
        };
        expect(load(dumpSource(doc))).toEqual(doc);
    });

    it('短 token 不拉成块标量（id / at / probe 仍是单行）', () => {
        const text = dumpSource({
            facts: { 'a#b': { value: 'v', id: 'app.port#default', evidence: { source: 'probe', probe: 'curl -s localhost' } } },
        });
        expect(text).toContain('id: app.port#default');
        expect(text).toContain('probe: curl -s localhost');
    });

    it('renderDoc 走同一套：真源里 value 是 |- 而不是单引号一行', () => {
        const f: Fact = {
            id: 'x',
            subject: 'app.port',
            aspect: 'default',
            value: '1000',
            review: 'accepted',
            lifecycle: 'active',
            evidence: { source: 'code', at: 'a.ts:1' },
        };
        // 缩进随层级（这里在 claim 下两层），只钉"块标量 + 内容在下一行"这个形状
        expect(renderDoc({ domain: 'app', note: '注', facts: [f] })).toMatch(/value: \|-\n +1000\n/);
    });
});
