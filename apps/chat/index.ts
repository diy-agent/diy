// index.ts — apps/chat 的装配（##505）：只存插件清单，业务全在 @diy-agent/bot。
//
// `createBotChat({ home })` = bot 领域 + 会话编排（一个 bot 一条长期会话，落 jsonl）；
// 模型目录 / 价目由 @diy-agent/model-catalog 读（**不含 key**）。
// 内存入口（main-memory.mjs）只换注入的宿主：`createAssembly({ sessions: …内存 store… })`。

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
    /** 注入的 bot 对话宿主（内存入口传自己的）；缺省 = `DIY_HOME` 下的落盘宿主 */
    readonly sessions?: unknown;
    /** 窗口标题；缺省 `TITLE`（内存入口传内存模式的标题） */
    readonly title?: string;
}

/** 按注入构造整份装配清单（纯装配：不打开会话，宿主自己是懒的） */
export function createAssembly(options: AssemblyOptions = {}): Assembly {
    return {
        title: options.title ?? TITLE,
        plugins: [
            { id: "chat-page", type: "module", data: { module: chatPageMain }, config: chatConfig(options.sessions) },
            // ##467：模型配置页是独立插件 —— 删掉这一项，侧栏就没有「模型配置」入口。
            {
                id: "model-config-page",
                type: "module",
                data: { module: modelConfigPageMain },
                config: homeConfig(),
            },
            // ##474：Bot 配置页同构；这一行就是「装不装」的开关。
            {
                id: "bot-config-page",
                type: "module",
                data: { module: botConfigPageMain },
                config: homeConfig(),
            },
        ],
    };
}

/** 缺省装配（落盘入口）；内存入口自己调 `createAssembly`。 */
export const ASSEMBLY: Assembly = createAssembly();

/** 显式注入优先；否则 DIY_HOME 缺席（纯库 import / 单测）⇒ 不注入，插件退回单会话假回复。 */
function chatConfig(sessions: unknown): unknown {
    if (sessions !== undefined) return { sessions };
    const home = process.env["DIY_HOME"];
    return home ? { sessions: createBotChat({ home }) } : {};
}

/** 配置页只认数据根（`$DIY_HOME`）；缺席时页面方法会明确报错，不猜路径。 */
function homeConfig(): unknown {
    const home = process.env["DIY_HOME"];
    return home ? { home } : {};
}
