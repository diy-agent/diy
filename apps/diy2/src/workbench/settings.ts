// settings.ts —— 「设置」这一页的身份与地址。
//
// 为什么单独一个文件，而不留在 App.tsx 里：这三个字是对外的**约定**，四个地方指它 ——
// 地址栏（`/settings/model`）、标题栏齿轮、「模型配置不全」横幅上的「去配置」、
// 以及机器人配置页。放在壳里就等于把约定埋进实现；分出来之后，单测也能只引这一份，
// 不必把整个 React 壳拖进来。
//
// ⚠ 导入即生效（`registerPage` 是模块级副作用）：谁引这份常量，谁就顺带把这一页注册给
// entity-chat 的地址体系了。反过来，**忘了引**的后果是 `navigate('/settings/…')` 被判成
// 坏地址、静默落到第一个房间 —— 所以别把这行挪进函数里。

import { addressOf, registerPage, type NavAddress } from '@diy-agent/entity-chat';

/** 页类型。地址第一段就是它：`/settings/<段>` */
export const SETTINGS_PAGE = 'settings';

/**
 * 设置页的两段。第二段就是地址里的 `id`（`parseAddress` 只认 `page + id` 两段）。
 *
 * 为什么是地址而不是壳里的 `screen` 状态：每一段都能刷新 / 后退 / 贴链接（2026-11-24 用户报的
 * 「设置页点别的页切换不了」就是壳状态的病根）。多一段主题就多一个常量，不需要动壳。
 */
export const SETTINGS_SECTIONS = {
    model: { id: 'model', label: '模型', address: addressOf(SETTINGS_PAGE, 'model') },
    bots: { id: 'bots', label: '机器人', address: addressOf(SETTINGS_PAGE, 'bots') },
} as const;

export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

/** 缺省段（齿轮 / 横幅「去配置」都落在这里） */
export const SETTINGS_ADDRESS = SETTINGS_SECTIONS.model.address;

/** 机器人段：房间头那颗机器人按钮导航到这里（整张列表，不带类型） */
export const BOTS_ADDRESS = SETTINGS_SECTIONS.bots.address;

/**
 * 机器人段能深链的类型。
 *
 * 只做 task / project 两类（2026-11-24 用户裁）：房间头那颗按钮知道自己在哪类
 * 房间，点进来就该落在那类机器人上；其余类型（stock 之类）以后再说，先回落整张列表。
 */
export const PROFILE_TYPES = ['task', 'project'] as const;

export type ProfileType = (typeof PROFILE_TYPES)[number];

function isProfileType(type: string): type is ProfileType {
    return (PROFILE_TYPES as readonly string[]).includes(type);
}

/**
 * 机器人段的深链地址：带类型写成 `/settings/bots/task`。
 *
 * 借的是 room 地址那套：id 写成 `bots:<type>`，`formatId` 会拆成 `bots/<type>`，
 * 反过来 `parseAddress` 拼回 `bots:<type>` —— 与 `task:t-001` 同一套转义，
 * 不给设置页另发明一套地址语法。**认不得的类型回落整张列表**，不做「猜一个最像的」。
 */
export function botsAddressOf(type: string): NavAddress {
    return isProfileType(type) ? addressOf(SETTINGS_PAGE, `${SETTINGS_SECTIONS.bots.id}:${type}`) : BOTS_ADDRESS;
}

/** 地址 id → 深链类型。`bots`（整表）/ 不认识的类型 / 非机器人段 → undefined */
export function botTypeOf(id: string): ProfileType | undefined {
    const prefix = `${SETTINGS_SECTIONS.bots.id}:`;
    if (!id.startsWith(prefix)) return undefined;
    const type = id.slice(prefix.length);
    return isProfileType(type) ? type : undefined;
}

/**
 * 地址的 `id` → 段。不认识的段（手改的地址、旧链接）落到缺省段，不报错也不落白屏。
 */
export function sectionOf(id: string): SettingsSection {
    // 机器人段带深链后缀（`bots:task`）时也算机器人段 —— 否则贴进来 / 刷新的深链会静默
    // 掉到「模型」段，表现成「从任务房间点机器人，打开的是模型配置」
    if (id === SETTINGS_SECTIONS.bots.id || id.startsWith(`${SETTINGS_SECTIONS.bots.id}:`)) return 'bots';
    return id in SETTINGS_SECTIONS ? (id as SettingsSection) : 'model';
}

registerPage(SETTINGS_PAGE);
