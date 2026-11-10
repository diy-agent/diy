// store.ts —— 页面快照仓库（**无框架**：不认识 React）。
//
// 只做三件事：持有不可变快照 / 整体替换 / 变更广播。没有 selector、没有中间件 ——
// 快照只有一个来源（主进程 `snapshot`），谁需要谁订阅整份再自己挑字段。
//
// 为什么不把 React state 当仓库：显示状态不是真源（docs/plans/2026-11-02-concurrency-actor.md
// 判据 5）。所有变更都来自 `applySnapshot(主进程给的整份快照)`，UI 自己从不增量改 fields。

import type { BotView, ChatMetrics, ModelChoice, WireMessage } from './shared.js';

export interface ChatState {
    /** `snapshot` 方法存在（多 bot 宿主注入）→ 左栏 + 底部指标可见 */
    readonly multi: boolean;
    readonly bots: readonly BotView[];
    readonly bot: BotView | null;
    /**
     * 模型目录：**按需拉的缓存**，不是快照的一部分（##526）。
     * 打开配置面板 / 首启引导时调 `client.models()` 填它；切 bot 不碰。
     */
    readonly models: readonly ModelChoice[];
    readonly messages: readonly WireMessage[];
    readonly metrics: ChatMetrics | null;
    /** 新建 bot 的缺省模型（三段式 key；随 models 一起拿到） */
    readonly selectedModel: string;
    /** 一轮在飞：输入框与发送按钮禁用 */
    readonly busy: boolean;
    /** 空消息线的提示语（首启 / 没消息时不同） */
    readonly emptyText: string;
}

export function initialState(): ChatState {
    return {
        multi: false,
        bots: [],
        bot: null,
        models: [],
        messages: [],
        metrics: null,
        selectedModel: '',
        busy: false,
        emptyText: '还没有消息，说一句话开始。',
    };
}

export interface ChatStore {
    get(): ChatState;
    /** 整体替换（不是 merge 深层字段）：传进来的是完整快照或显式的局部视图 */
    patch(next: Partial<ChatState>): void;
    subscribe(listener: () => void): () => void;
}

export function createChatStore(init: ChatState = initialState()): ChatStore {
    let state = init;
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        patch(next) {
            state = { ...state, ...next };
            for (const listener of listeners) listener();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
