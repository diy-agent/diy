// botProfiles.ts —— 机器人配置（BotProfile）的**写面**：设置页「机器人」那一段专用。
//
// 为什么单独一个出口、而不是把 store 的 `actions` 放出去：与 `modelConfig.ts` 同一条理由 ——
// 写路径要一条一条设计语义（写完要刷新谁、失败了怎么回、护栏在哪）。这里只放机器人页真的需要的四个。
//
// **护栏不在这一层**：①「每类型至多一个默认应答」由库里的唯一索引钉住（`bot_profiles_primary`）；
// ②「每类最后一个机器人不许删」由服务端拦（删光了那类房间就没人应答）。这里只负责写完刷新，
// 让房间头的成员胶囊立刻跟上 —— 用户刚在界面上点了保存。

import type { BotProfile, BotProfileDefaults } from '@diy-agent/protocol';

import { diy2, refreshBotProfiles } from './store';

export type { BotProfile };

/** `botProfiles.create` / `botProfiles.update` 的可选字段（`modelKey: null` = 清空 → 继续继承） */
export interface BotProfileInput {
    /** create 必填；update 缺省 = 不改名 */
    name?: string;
    color?: string;
    instructions?: string;
    modelKey?: string | null;
    reasoningEffort?: string | null;
    primary?: boolean;
}

export const botProfiles = {
    /** 建一个机器人配置。第一个自动当该类型的默认应答（`primary` 缺省由服务端算） */
    async create(input: BotProfileInput & { type: string; name: string }): Promise<BotProfile> {
        const profile = await diy2.botProfiles.create(input);
        await refreshBotProfiles();
        return profile;
    },

    async update(input: BotProfileInput & { id: string }): Promise<BotProfile> {
        const profile = await diy2.botProfiles.update(input);
        await refreshBotProfiles();
        return profile;
    },

    async remove(id: string): Promise<void> {
        await diy2.botProfiles.remove(id);
        await refreshBotProfiles();
    },

    /** 类型默认（`bot_profile_defaults`）：project / task 各一套 model / effort，机器人只存 override */
    async defaults(input: {
        type: string;
        modelKey?: string | null;
        reasoningEffort?: string | null;
    }): Promise<BotProfileDefaults> {
        const config = await diy2.botProfiles.config.set(input);
        await refreshBotProfiles();
        return config;
    },
};
