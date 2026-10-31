// channels.ts — IPC 通道名 + 两个桥的接口（主进程与两个 preload 共用**同一份常量**）。
//
// 为什么要单独成文件：preload 里手写字符串最容易和主进程悄悄对不上（改名后一边收一边发，
// 表现是「点了没反应」）。这里一份，三处 import。

import type { BarState, CurrentInstance, ShellLayout } from './index.js';

/** 主进程 → 横条：整份状态推送（横条只负责画） */
export const BAR_STATE_CHANNEL = 'remote-shell:bar:state';

/** 横条 → 主进程：读写（invoke） */
export const BAR_INVOKE_CHANNEL = 'remote-shell:bar:invoke';

/** 远程页面 → 主进程：只读「当前位置」 */
export const SHELL_CURRENT_CHANNEL = 'remote-shell:shell:current';

/** 横条能做的四件事（没有「确认 / 拦截」这一类：本壳不做危险操作二次确认） */
export type BarMethod = 'state' | 'connect' | 'refresh' | 'layout';

export interface BarRequest {
    method: BarMethod;
    /** method=connect 时的输入（用户手输或点列表；主进程自己归一化） */
    endpoint?: string;
}

/** 横条页（本地 data: 页）拿到的桥 —— 只有这四个方法，够画横条用 */
export interface BarBridge {
    getState(): Promise<BarState>;
    connect(endpoint: string): Promise<void>;
    /** 重新跑一遍发现链（横条右侧 ⟳） */
    refresh(): Promise<void>;
    /** 布局自述：判据 3 的结构性证据（横条 vs 页面区几何） */
    layout(): Promise<ShellLayout>;
    /** 主进程推状态（返回退订函数） */
    onState(handler: (state: BarState) => void): () => void;
}

/**
 * 远程页面拿到的桥：**只读**。
 * 不给切换 / 不给改状态 —— 当前位置是壳的事，远程页面只能问「我在哪」。
 */
export interface ShellBridge {
    current(): Promise<CurrentInstance | null>;
}
