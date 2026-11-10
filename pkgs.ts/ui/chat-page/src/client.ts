// client.ts —— **领域式 rpc 客户端**：方法名与入参形状只出现在这一个文件里。
//
// 规则（docs/ui-architecture.md §2.1）：组件里不许出现 `invoke("selectBot", …)` 这类字符串方法名。
// 理由：主进程改协议时要**编译期**报错，而不是运行期在某个按钮里静默 `Unknown method`。
// 这里只做「字符串 → 有类型的方法」，不做缓存、不做重试 —— 那些是页面的事。

import type { PageContext } from '@diy-agent/workbench-ui';
import type { BotChatSnapshot, CompactInfo, ModelChoices } from './shared.js';

/** 新建 / 修改 bot 的表单载荷（与主进程 botDraftInputOf 同形） */
export interface BotDraft {
    readonly name: string;
    readonly model: string;
    readonly instructions: string;
    readonly reasoningEffort: string;
}

export interface BotUpdate extends BotDraft {
    readonly id: string;
}

export interface FirstBotDraft {
    readonly model: string;
    readonly name?: string;
    readonly instructions: string;
}

export interface ChatClient {
    readonly snapshot: () => Promise<BotChatSnapshot>;
    /** 模型目录（**按需拉**：配模型 / 新建 bot 时才要；##526 起不在快照里） */
    readonly models: () => Promise<ModelChoices>;
    readonly selectBot: (id: string) => Promise<BotChatSnapshot>;
    readonly createBot: (draft: BotDraft) => Promise<BotChatSnapshot>;
    readonly updateBot: (draft: BotUpdate) => Promise<BotChatSnapshot>;
    readonly removeBot: (id: string) => Promise<BotChatSnapshot>;
    readonly createFirstBot: (draft: FirstBotDraft) => Promise<BotChatSnapshot>;
    readonly send: (text: string) => Promise<BotChatSnapshot>;
    readonly compactInfo: () => Promise<CompactInfo>;
    readonly compact: (keepRounds: number) => Promise<BotChatSnapshot>;
}

export function createChatClient(ctx: PageContext): ChatClient {
    return {
        snapshot: () => ctx.invoke<BotChatSnapshot>('snapshot'),
        models: () => ctx.invoke<ModelChoices>('models'),
        selectBot: (id) => ctx.invoke<BotChatSnapshot>('selectBot', { id }),
        createBot: (draft) => ctx.invoke<BotChatSnapshot>('createBot', draft),
        updateBot: (draft) => ctx.invoke<BotChatSnapshot>('updateBot', draft),
        removeBot: (id) => ctx.invoke<BotChatSnapshot>('removeBot', { id }),
        createFirstBot: (draft) => ctx.invoke<BotChatSnapshot>('createFirstBot', draft),
        send: (text) => ctx.invoke<BotChatSnapshot>('send', { text }),
        compactInfo: () => ctx.invoke<CompactInfo>('compactInfo'),
        compact: (keepRounds) => ctx.invoke<BotChatSnapshot>('compact', { keepRounds }),
    };
}
