// settings.ts —— 「设置」这一页的身份与地址。
//
// 为什么单独一个文件，而不留在 App.tsx 里：这三个字是对外的**约定**，四个地方指它 ——
// 地址栏（`/settings/model`）、标题栏齿轮、「模型配置不全」横幅上的「去配置」、
// 以及将来的角色配置页。放在壳里就等于把约定埋进实现；分出来之后，单测也能只引这一份，
// 不必把整个 React 壳拖进来。
//
// ⚠ 导入即生效（`registerPage` 是模块级副作用）：谁引这份常量，谁就顺带把这一页注册给
// entity-chat 的地址体系了。反过来，**忘了引**的后果是 `navigate('/settings/…')` 被判成
// 坏地址、静默落到第一个房间 —— 所以别把这行挪进函数里。

import { addressOf, registerPage } from '@diy-agent/entity-chat';

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
    roles: { id: 'roles', label: '角色', address: addressOf(SETTINGS_PAGE, 'roles') },
} as const;

export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

/** 缺省段（齿轮 / 横幅「去配置」都落在这里） */
export const SETTINGS_ADDRESS = SETTINGS_SECTIONS.model.address;

/** 角色段：房间头「角色」按钮导航到这里 */
export const ROLES_ADDRESS = SETTINGS_SECTIONS.roles.address;

/**
 * 地址的 `id` → 段。不认识的段（手改的地址、旧链接）落到缺省段，不报错也不落白屏。
 */
export function sectionOf(id: string): SettingsSection {
    return id in SETTINGS_SECTIONS ? (id as SettingsSection) : 'model';
}

registerPage(SETTINGS_PAGE);
