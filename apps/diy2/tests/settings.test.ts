// 设置页的地址约定：`/settings/model` 是一个**能贴、能刷新、能后退**的位置。
//
// 这些断言看着琐碎，钉的却是三条已经在浏览器里踩过的坑：
//   1. 地址里必须有第二段（`parseAddress` 只认 `page + id`）—— 否则裸 `/settings`
//      解析成 undefined，刷新就落回第一个房间；
//   2. 页类型必须注册过（`registerPage`）—— 否则 `navigate` 把它当坏地址，静默跳房间，
//      表现成「点了齿轮没反应」；
//   3. 同一位置只有一种写法 —— 否则每次导航都往历史里堆一条，后退要按两次。

import { formatAddress, knownPage, parseAddress, sameAddress } from '@diy-agent/entity-chat';
import { describe, expect, it } from 'vitest';

import { ROLES_ADDRESS, rolesAddressOf, rolesTypeOf, sectionOf, SETTINGS_ADDRESS, SETTINGS_PAGE } from '../src/workbench/settings';

describe('设置页地址', () => {
    it('页类型已注册（注册是 settings.ts 的模块级副作用）', () => {
        expect(knownPage(SETTINGS_PAGE)).toBe(true);
    });

    it('默认地址写成 /settings/model', () => {
        expect(formatAddress(SETTINGS_ADDRESS)).toBe('/settings/model');
    });

    it('解析回来还是同一个位置', () => {
        const parsed = parseAddress('/settings/model');
        expect(parsed).toBeDefined();
        expect(sameAddress(parsed, SETTINGS_ADDRESS)).toBe(true);
    });

    it('裸 /settings 不构成位置（没有第二段）', () => {
        expect(parseAddress('/settings')).toBeUndefined();
    });

    it('「看哪一段」是地址的一部分：/settings/roles 与 /settings/model 不是同一处', () => {
        expect(sameAddress(parseAddress('/settings/roles'), SETTINGS_ADDRESS)).toBe(false);
    });

    it('角色段也是一个能贴的地址：/settings/roles', () => {
        expect(formatAddress(ROLES_ADDRESS)).toBe('/settings/roles');
        expect(sameAddress(parseAddress('/settings/roles'), ROLES_ADDRESS)).toBe(true);
    });

    it('不认识的段落到缺省段（手改地址 / 旧链接不炸）', () => {
        expect(sectionOf('model')).toBe('model');
        expect(sectionOf('roles')).toBe('roles');
        expect(sectionOf('随便写的')).toBe('model');
        expect(sectionOf('')).toBe('model');
    });

    it('角色深链：/settings/roles/task 是一个能贴的地址，且落到角色段', () => {
        const address = rolesAddressOf('task');
        expect(formatAddress(address)).toBe('/settings/roles/task');
        const parsed = parseAddress('/settings/roles/task');
        expect(sameAddress(parsed, address)).toBe(true);
        // 贴进来 / 刷新都靠这两行：段还得是角色段，类型还得认得出来
        expect(sectionOf(parsed!.id)).toBe('roles');
        expect(rolesTypeOf(parsed!.id)).toBe('task');
        expect(rolesTypeOf('roles:project')).toBe('project');
    });

    it('深链只做 task / project：其余类型回落整张列表', () => {
        expect(formatAddress(rolesAddressOf('stock'))).toBe('/settings/roles');
        expect(rolesTypeOf('roles')).toBeUndefined();
        expect(rolesTypeOf('roles:stock')).toBeUndefined();
        expect(rolesTypeOf('roles:task:extra')).toBeUndefined();
        // 即便类型不认识，段依旧是角色段（不静默掉到模型段）
        expect(sectionOf('roles:stock')).toBe('roles');
    });
});
