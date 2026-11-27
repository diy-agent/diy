// roles.test.ts —— 角色 → 房间成员的**派生**规则（2026-11-24 裁）。
//
// 为什么要单独钉这几条：成员不再是「房间表里存的一行」，而是每次从角色表算出来的。
// 算错了不会报错，只会表现成「默认应答换人了」「@ 补全选不中」—— 排起来极费劲。
// 三条硬要求：
//   1. primary 永远排在第一位（`primaryMemberOf` 兜底取第一个成员 = 默认应答）
//   2. 其余按建得早的在前，**同 createdAt 也不能抖动**（用 id 兜底，别依赖 Map/DB 顺序）
//   3. 只出本类型的角色（project 房间不该看见 task 的席位）

import { botOfProfile, membersOfType } from '@diy-agent/protocol';
import { describe, expect, it } from 'vitest';

import type { BotProfile, BotProfileDefaults } from '../src/types';

function role(overrides: Partial<BotProfile> & { id: string }): BotProfile {
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

    it('单聊：只返回该类型的主 bot 一个（哪怕它建得最晚）', () => {
        const roles = [
            role({ id: 'late', createdAt: 300 }),
            role({ id: 'primary', createdAt: 200, primary: true }),
            role({ id: 'early', createdAt: 100 }),
        ];
        expect(membersOfType(roles, 'project')).toEqual([{ botId: 'primary', primary: true }]);
        // 同类型的其它角色**不再**跟着进房间（2026-11-27 用户：房间只留主 bot）
        expect(membersOfType(roles, 'project').map((member) => member.botId)).not.toContain('early');
        expect(membersOfType(roles, 'project').map((member) => member.botId)).not.toContain('late');
    });

    it('没有 primary 的类型兜底取建得最早的（id 兜底），且不改入参顺序', () => {
        const roles = [role({ id: 'b' }), role({ id: 'a' })];
        expect(membersOfType(roles, 'project').map((member) => member.botId)).toEqual(['a']);
        // 派生不能就地 sort 掉调用方的数组（那会让 listRoles 的顺序随房间而变化）
        expect(roles.map((item) => item.id)).toEqual(['b', 'a']);
    });

    it('一个类型下一个角色都没有 ⇒ 空名单，不拿别的类型凑数', () => {
        expect(membersOfType([role({ id: 't', type: 'task' })], 'project')).toEqual([]);
    });
});

describe('botOfProfile（角色 → 房间里的化身）', () => {
    it('人格取 instructions、模型 null 落成空串（房间侧靠 || 继续继承）', () => {
        const bot = botOfProfile(role({ id: 'r1', name: '主程', color: '#123', instructions: '工程视角' }));
        expect(bot).toMatchObject({ id: 'r1', name: '主程', color: '#123', persona: '工程视角', modelKey: '' });
    });

    it('角色自己选了模型就带出去（优先级：房间 > 角色 > 全局默认）', () => {
        expect(botOfProfile(role({ id: 'r1', modelKey: 'acc@p/m' })).modelKey).toBe('acc@p/m');
    });
});

describe('botOfProfile 的模型解析：override ?? 类型默认（2026-11-26 role_config）', () => {
    const config: BotProfileDefaults = {
        type: 'project',
        modelKey: 'acc@prov/type-default',
        reasoningEffort: 'low',
        updatedAt: 0,
    };

    it('角色 modelKey 为 null 时走类型默认（几百个任务共享一套）', () => {
        expect(botOfProfile(role({ id: 'r1', modelKey: null }), config).modelKey).toBe('acc@prov/type-default');
    });

    it('角色填了 override 就覆盖类型默认', () => {
        expect(botOfProfile(role({ id: 'r1', modelKey: 'acc@prov/override' }), config).modelKey).toBe(
            'acc@prov/override',
        );
    });

    it('没有类型默认时保持空串（继续继承房间 → 全局默认）', () => {
        expect(botOfProfile(role({ id: 'r1', modelKey: null })).modelKey).toBe('');
    });
});
