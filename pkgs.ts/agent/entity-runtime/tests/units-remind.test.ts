// units-remind.test.ts —— 「提醒模型把人的话变成需求」的三档开关与措辞
//
// 这一层最容易坏的不是逻辑，而是**口径分叉**：A（system）、B（units.hint）、C（工具描述）
// 各说一套「需求 vs 步骤」，模型就会按最宽松的那句办事。所以这里钉三件事：
//   · 档位解析：`off` / 组合 / 写错字母时不至于让提醒整体消失
//   · 三档措辞都含同一条判据（需要人工核对的软约束，用「同一份常量」保证）
//   · B 的触发条件：只在「账本空」或「上次账本变更之后有人发言」时出现
import { describe, expect, it } from 'vitest';

import {
    LEDGER_SHAPE,
    envelopeHint,
    parseRemindMode,
    promptReminder,
    resolveRemindMode,
    toolReminder,
    type RemindMode,
} from '../src/units-remind';
import { unitBoard, unitsContextValue } from '../src/units';

const ALL: RemindMode = { prompt: true, envelope: true, tool: true };

describe('档位解析', () => {
    it('空 = 全开；off / none / 0 = 全关', () => {
        expect(parseRemindMode(undefined)).toEqual(ALL);
        expect(parseRemindMode('')).toEqual(ALL);
        for (const off of ['off', 'none', '0', 'OFF']) {
            expect(parseRemindMode(off)).toEqual({ prompt: false, envelope: false, tool: false });
        }
    });

    it('字母组合各自独立；写错的字母被忽略（不能让提醒整体消失）', () => {
        expect(parseRemindMode('a')).toEqual({ prompt: true, envelope: false, tool: false });
        expect(parseRemindMode('bc')).toEqual({ prompt: false, envelope: true, tool: true });
        expect(parseRemindMode('ab?c')).toEqual(ALL);
    });

    it('环境变量优先于文件；两处都没有 = 全开', () => {
        expect(resolveRemindMode({ env: { DIY2_UNITS_REMIND: 'off' }, home: '/nonexistent' })).toEqual({
            prompt: false,
            envelope: false,
            tool: false,
        });
        expect(resolveRemindMode({ env: {}, home: '/nonexistent' })).toEqual(ALL);
    });
});

describe('三档措辞', () => {
    it('A / C 都带上同一条判据（账本只有两层）', () => {
        expect(promptReminder(ALL)).toContain(LEDGER_SHAPE);
        expect(toolReminder(ALL)).toContain(LEDGER_SHAPE);
    });

    it('关掉的档位产出空串（不是缺省文案 —— 否则「关」等于没关）', () => {
        const off: RemindMode = { prompt: false, envelope: false, tool: false };
        expect(promptReminder(off)).toBe('');
        expect(toolReminder(off)).toBe('');
        expect(envelopeHint(off, { empty: true, humanSince: true })).toBeUndefined();
    });
});

describe('B 档的触发条件', () => {
    it('账本空 ⇒ 给一条「先落一条需求」', () => {
        expect(envelopeHint(ALL, { empty: true, humanSince: false })).toContain('账本还是空的');
    });

    it('上次账本变更之后有人发言 ⇒ 提醒判新需求', () => {
        expect(envelopeHint(ALL, { empty: false, humanSince: true })).toContain('有人发言');
    });

    it('账本非空、也没有新发言 ⇒ 不出 hint（不常驻噪音）', () => {
        expect(envelopeHint(ALL, { empty: false, humanSince: false })).toBeUndefined();
    });
});

describe('units 节对 hint 的处理', () => {
    it('空树 + 有 hint ⇒ 整节仍在（内容就是那条 hint）', () => {
        const value = unitsContextValue(unitBoard([]), '先把这句话拆成需求');
        expect(value).toEqual({ ready: [], doing: [], hint: '先把这句话拆成需求' });
    });

    it('空树 + 没 hint ⇒ 整节缺席（不造空壳）', () => {
        expect(unitsContextValue(unitBoard([]))).toBeUndefined();
    });

    it('非空树 + hint ⇒ hint 与树同时给', () => {
        const board = unitBoard([{ id: 'u1', title: '需求一', status: 'open', seq: 1, parent: null }]);
        const value = unitsContextValue(board, '有新发言');
        expect(value?.hint).toBe('有新发言');
        expect(value?.tree?.length).toBe(1);
    });
});
