// roles.ts —— 角色（BotRole）的**写面**：设置页「角色」那一段专用。
//
// 为什么单独一个出口、而不是把 store 的 `actions` 放出去：与 `modelConfig.ts` 同一条理由 ——
// 写路径要一条一条设计语义（写完要刷新谁、失败了怎么回、护栏在哪）。这里只放角色页真的需要的四个。
//
// **护栏不在这一层**：①「每类型至多一个 primary」由库里的唯一索引钉住（`bot_roles_primary`）；
// ②「每类最后一个角色不许删」由服务端拦（删光了那类房间就没人应答）。这里只负责写完刷新，
// 让房间头的成员胶囊立刻跟上 —— 用户刚在界面上点了保存。

import type { BotRole } from '@diy-agent/protocol';

import { diy2, refreshRoles } from './store';

export type { BotRole };

/** `roles.create` / `roles.update` 的可选字段（`modelKey: null` = 清空 → 继续继承） */
export interface RoleInput {
    /** create 必填；update 缺省 = 不改名 */
    name?: string;
    color?: string;
    instructions?: string;
    modelKey?: string | null;
    reasoningEffort?: string | null;
    primary?: boolean;
}

export const roles = {
    /** 建一个角色。第一个角色自动当该类型的默认应答（`primary` 缺省由服务端算） */
    async create(input: RoleInput & { type: string; name: string }): Promise<BotRole> {
        const role = await diy2.roles.create(input);
        await refreshRoles();
        return role;
    },

    async update(input: RoleInput & { id: string }): Promise<BotRole> {
        const role = await diy2.roles.update(input);
        await refreshRoles();
        return role;
    },

    async remove(id: string): Promise<void> {
        await diy2.roles.remove(id);
        await refreshRoles();
    },
};
