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
 * 设置页的默认地址：看的是「模型」这一段。
 *
 * 第二段（`model`）不是装饰 —— `parseAddress` 只认 `page + id` 两段，裸 `/settings`
 * 解析不出来。将来多一段主题就多一个地址（`/settings/roles`），不需要新增壳状态。
 */
export const SETTINGS_ADDRESS = addressOf(SETTINGS_PAGE, 'model');

registerPage(SETTINGS_PAGE);
