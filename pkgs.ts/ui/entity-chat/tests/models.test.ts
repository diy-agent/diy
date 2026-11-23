// modelLabel —— 视图层唯一的「模型 key 怎么显示」入口。
//
// 锁的是一条实测过的错误：房间没选过模型时，服务端曾往行里写一个占位 key
// （`none@none/none`），界面照着目录规则拼成「none · none@none」，看起来像真配好了，
// 其实发不出去。现在空串有明确含义（跟随 defaultModel），显示也不能含糊。

import { describe, expect, it } from 'vitest';

import { modelLabel } from '../src/models';

describe('modelLabel', () => {
    it("空串（没显式选过模型）=「未设置模型」，不冒充任何 provider/账号", () => {
        expect(modelLabel([], '')).toBe('未设置模型');
        expect(modelLabel([], '   ')).toBe('未设置模型');
    });

    it('形状对的 key ⇒ 「模型名 · 账号@provider」（目录里没有就退回 key 里的模型名）', () => {
        expect(modelLabel([], 'main@acme/fast')).toBe('fast · main@acme');
    });

    it('形状都不对 ⇒ 原样显示（不编造）', () => {
        expect(modelLabel([], 'garbage')).toBe('garbage');
    });
});
