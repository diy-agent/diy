// index.ts — apps/chat 的装配：workbench + chat 插件（注入多会话宿主）。
//
// ##465：与 apps/minimal 的差别只有装配这一层 ——
//   · 会话宿主 = `$DIY_HOME/sessions/chat/` 下的多会话（落盘走 session-store-jsonl）
//   · 模型目录 = @diy-agent/model-catalog（读 model.yaml / providers.custom.yaml，**不含 key**）
//   · chat-page 插件本身不认识文件系统 / 模型配置：它只认注入的 ChatSessionHost 端口

import * as chatPageMain from "@diy-agent/chat-page/main";
import type { PluginEntry } from "@diy-agent/workbench";
import { createChatSessions } from "./sessions.js";
import { TITLE } from "./title.js";

export interface Assembly {
    /** 窗口标题 */
    readonly title: string;
    /** 主进程侧插件清单（按 inject 排序后装配） */
    readonly plugins: readonly PluginEntry[];
}

export const ASSEMBLY: Assembly = {
    title: TITLE,
    plugins: [
        {
            id: "chat-page",
            type: "module",
            data: { module: chatPageMain },
            config: chatConfig(),
        },
    ],
};

/**
 * 多会话配置：`DIY_HOME` 缺席（被当纯库 import / 单测）→ 不注入，插件退回单会话假回复形态。
 * 宿主本身是懒的：读目录 / 开桶都发生在第一次页面调用。
 */
function chatConfig(): unknown {
    const home = process.env["DIY_HOME"];
    if (!home) return {};
    return { sessions: createChatSessions({ home }) };
}
