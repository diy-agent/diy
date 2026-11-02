// index.ts — apps/chat 的装配（##505）：只存插件清单，业务全在 @diy-agent/bot。
// 内存入口（main-memory.mjs）只换注入的宿主与 store：`createAssembly({ home, sessions, botStore })`。

import * as botConfigPageMain from "@diy-agent/bot-config-page";
import * as chatPageMain from "@diy-agent/chat-page/main";
import * as modelConfigPageMain from "@diy-agent/model-config-page";
import type { PluginEntry } from "@diy-agent/workbench";
import { createBotChat, createFileBotStore, type BotStore } from "@diy-agent/bot";
import { join } from "node:path";
import { TITLE } from "./title.js";

export interface Assembly {
    readonly title: string;
    readonly plugins: readonly PluginEntry[];
}

export interface AssemblyOptions {
    readonly sessions?: unknown;
    readonly home?: string;
    /** 聊天宿主与「Bot 配置」页**共用同一个**（不传则按 home 建，##505 bug 二修） */
    readonly botStore?: BotStore;
    readonly title?: string;
}

/** 按注入构造装配清单（纯装配：宿主自己是懒的） */
export function createAssembly(options: AssemblyOptions = {}): Assembly {
    const home = options.home ?? process.env["DIY_HOME"];
    // ##505 bug 二修：落盘入口也只建一个 store（之前两页各建，文件模式同样中招）
    const botStore = options.botStore ?? (home ? createFileBotStore({ home, sessionsDir: join(home, "sessions", "chat") }) : undefined);
    return {
        title: options.title ?? TITLE,
        plugins: [
            { id: "chat-page", type: "module", data: { module: chatPageMain }, config: chatConfig(home, options.sessions, botStore) },
            {
                id: "model-config-page",
                type: "module",
                data: { module: modelConfigPageMain },
                config: homeConfig(home),
            },
            {
                id: "bot-config-page",
                type: "module",
                data: { module: botConfigPageMain },
                config: botConfig(home, botStore),
            },
        ],
    };
}

export const ASSEMBLY: Assembly = createAssembly();
/** 显式注入优先；否则数据根缺席（纯库 import / 单测）⇒ 不注入，插件退回单会话假回复。 */
function chatConfig(home: string | undefined, sessions: unknown, botStore: BotStore | undefined): unknown {
    if (sessions !== undefined) return { sessions };
    if (home === undefined || home === "") return {};
    return { sessions: createBotChat({ home, botStore }) };
}

/** Bot 配置页：注入了 store 就共用（内存入口），否则按数据根建文件实现（落盘入口）。 */
function botConfig(home: string | undefined, store: BotStore | undefined): unknown {
    if (store !== undefined) return home === undefined || home === "" ? { store } : { home, store };
    return homeConfig(home);
}

/** 配置页只认数据根（`$DIY_HOME`）；缺席时页面方法会明确报错，不猜路径。 */
function homeConfig(home: string | undefined): unknown {
    return home === undefined || home === "" ? {} : { home };
}
