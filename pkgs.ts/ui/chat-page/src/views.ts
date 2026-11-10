// views.ts — 聊天页的「tab 插槽」契约（##539）。
//
// ── 为什么是 `load` 而不是直接给组件 ──
//   VSCode 的扩展在 package.json 里只写 `id`，宿主按 id 查表加载 —— 正因如此才能
//   「装个扩展就多一个面板」。我们暂时做不到运行时发现（diy 是 monorepo，加 view 要发版），
//   但**接口先按可懒加载的形状定义**：将来把 `load` 从 `() => Promise.resolve(mod)`
//   换成 `() => import('@diy-agent/chat-view-x')` 甚至远程取模块，**调用方不用改**。
//
// ── 现在怎么用（apps/chat/renderer.ts）──
//   chatPageViewWith([
//     { id: 'standard', label: '标准', order: 10, load: () => Promise.resolve({ default: StandardView }) },
//     { id: 'devtools', label: '调试', order: 90, load: () => Promise.resolve({ default: DevtoolsView }) },
//   ])

import type * as React from 'react';
import type { ChatClient } from './client.js';
import type { ChatState } from './store.js';

/** 一个聊天视图拿到的全部东西：**同一份 state / client**，只是投影不同 */
export interface ChatViewProps {
    readonly state: ChatState;
    readonly client: ChatClient;
}

/** 一个 tab = 一个视图贡献 */
export interface ChatViewContribution {
    readonly id: string;
    readonly label: string;
    /** tab 排序（小在前）；缺省 100 */
    readonly order?: number;
    /** 懒加载器：宿主只在**切到这个 tab** 时才调它 */
    readonly load: () => Promise<{ default: React.ComponentType<ChatViewProps> }>;
}
