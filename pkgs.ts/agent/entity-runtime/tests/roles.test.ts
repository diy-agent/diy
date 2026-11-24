// roles.test.ts —— 角色 → 房间成员的**派生**规则（2026-11-24 裁）。
//
// 为什么要单独钉这几条：成员不再是「房间表里存的一行」，而是每次从角色表算出来的。
// 算错了不会报错，只会表现成「默认应答换人了」「@ 补全选不中」—— 排起来极费劲。
// 三条硬要求：
//   1. primary 永远排在第一位（`primaryMemberOf` 兜底取第一个成员 = 默认应答）
//   2. 其余按建得早的在前，**同 createdAt 也不能抖动**（用 id 兜底，别依赖 Map/DB 顺序）
//   3. 只出本类型的角色（project 房间不该看见 task 的席位）

import { botOfRole, membersOfType } from '@diy-agent/protocol';
import { describe, expect, it } from 'vitest';

import type { BotRole } from '../src/types';

function role(overrides: Partial<BotRole> & { id: string }): BotRole {
    return {
        type: 'project',
        name: overrides.id,
        color: '#000',
        instructions: '',
        primary: false,
        modelKey: null,
        reasoningEffort: null,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

describe('membersOfType（角色 → 成员名单）', () => {
    it('只出本类型的角色', () => {
        const roles = [role({ id: 'p1' }), role({ id: 't1', type: 'task' })];
        expect(membersOfType(roles, 'project').map((member) => member.botId)).toEqual(['p1']);
        expect(membersOfType(roles, 'task').map((member) => member.botId)).toEqual(['t1']);
        expect(membersOfType(roles, 'stock')).toEqual([]);
    });

    it('primary 排第一（哪怕它建得最晚），其余按建得早排', () => {
        const roles = [
            role({ id: 'late', createdAt: 300 }),
            role({ id: 'primary', createdAt: 200, primary: true }),
            role({ id: 'early', createdAt: 100 }),
        ];
        expect(membersOfType(roles, 'project').map((member) => member.botId)).toEqual(['primary', 'early', 'late']);
        // primary 只有第一位带旗（房间侧靠它判断「默认应答」）
        expect(membersOfType(roles, 'project').map((member) => member.primary)).toEqual([true, undefined, undefined]);
    });

    it('同一时刻建的也不错位：id 兜底，且不改入参顺序', () => {
        const roles = [role({ id: 'b' }), role({ id: 'a' })];
        expect(membersOfType(roles, 'project').map((member) => member.botId)).toEqual(['a', 'b']);
        // 派生不能就地 sort 掉调用方的数组（那会让 listRoles 的顺序随房间而变化）
        expect(roles.map((item) => item.id)).toEqual(['b', 'a']);
    });
});

describe('botOfRole（角色 → 房间里的化身）', () => {
    it('人格取 instructions、模型 null 落成空串（房间侧靠 || 继续继承）', () => {
        const bot = botOfRole(role({ id: 'r1', name: '主程', color: '#123', instructions: '工程视角' }));
        expect(bot).toMatchObject({ id: 'r1', name: '主程', color: '#123', persona: '工程视角', modelKey: '' });
    });

    it('角色自己选了模型就带出去（优先级：房间 > 角色 > 全局默认）', () => {
        expect(botOfRole(role({ id: 'r1', modelKey: 'acc@p/m' })).modelKey).toBe('acc@p/m');
    });
});
