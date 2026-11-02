// index.ts — apps/chat 的装配（##505）：只存插件清单，业务全在 @diy-agent/bot。
// 内存入口（main-memory.mjs）只换注入的宿主与 store：`createAssembly({ home, sessions, botStore })`。

import * as botConfigPageMain from "@diy-agent/bot-config-page";
import * as chatPageMain from "@diy-agent/chat-page/main";
import * as modelConfigPageMain from "@diy-agent/model-config-page";
import type { PluginEntry } from "@diy-agent/workbench";
import { createBotChat } from "@diy-agent/bot";
import { TITLE } from "./title.js";

export interface Assembly {
    readonly title: string;
    readonly plugins: readonly PluginEntry[];
}

export interface AssemblyOptions {
    /** 注入的 bot 对话宿主（内存入口传自己的）；缺省 = `home` 下的落盘宿主 */
    readonly sessions?: unknown;
    /** 数据根；缺省读 `DIY_HOME`（测试可显式指定） */
    readonly home?: string;
    /** 注入的 bot 存储：聊天宿主与「Bot 配置」页**共用同一个**（内存入口必须传，##505 bug） */
    readonly botStore?: unknown;
    /** 窗口标题；缺省 `TITLE` */
    readonly title?: string;
}

/** 按注入构造整份装配清单（纯装配：宿主自己是懒的） */
export function createAssembly(options: AssemblyOptions = {}): Assembly {
    const home = options.home ?? process.env["DIY_HOME"];
    return {
        title: options.title ?? TITLE,
        plugins: [
            { id: "chat-page", type: "module", data: { module: chatPageMain }, config: chatConfig(home, options.sessions) },
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
                config: botConfig(home, options.botStore),
            },
        ],
    };
}

/** 缺省装配（落盘入口）；内存入口自己调 `createAssembly`。 */
export const ASSEMBLY: Assembly = createAssembly();

/** 显式注入优先；否则数据根缺席（纯库 import / 单测）⇒ 不注入，插件退回单会话假回复。 */
function chatConfig(home: string | undefined, sessions: unknown): unknown {
    if (sessions !== undefined) return { sessions };
    return home === undefined || home === "" ? {} : { sessions: createBotChat({ home }) };
}

/** Bot 配置页：注入了 store 就共用（内存入口），否则按数据根建文件实现（落盘入口）。 */
function botConfig(home: string | undefined, store: unknown): unknown {
    if (store !== undefined) return home === undefined || home === "" ? { store } : { home, store };
    return homeConfig(home);
}

/** 配置页只认数据根（`$DIY_HOME`）；缺席时页面方法会明确报错，不猜路径。 */
function homeConfig(home: string | undefined): unknown {
    return home === undefined || home === "" ? {} : { home };
}
