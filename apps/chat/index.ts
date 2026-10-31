// index.ts — apps/chat 的装配：workbench + chat 插件（注入多会话宿主）。
//
// ##465：与 apps/minimal 的差别只有装配这一层 ——
//   · 会话宿主 = `$DIY_HOME/sessions/chat/` 下的多会话（落盘走 session-store-jsonl）
//   · 模型目录 = @diy-agent/model-catalog（读 model.yaml / providers.custom.yaml，**不含 key**）
//   · bot = @diy-agent/bot 的「大王助手」（##469 单 bot 一刀；会话归属写 session 目录里的 bot.json）
//   · chat-page 插件本身不认识文件系统 / 模型配置：它只认注入的 ChatSessionHost 端口

import * as botConfigPageMain from "@diy-agent/bot-config-page";
import * as chatPageMain from "@diy-agent/chat-page/main";
import * as modelConfigPageMain from "@diy-agent/model-config-page";
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
        {
            // ##467：模型配置页是**独立插件** —— 删掉这一项，主进程就不再交付该页，
            // 侧栏里的「模型配置」随之消失（renderer 侧注册与否只决定「怎么画」）。
            id: "model-config-page",
            type: "module",
            data: { module: modelConfigPageMain },
            config: homeConfig(),
        },
        {
            // ##474：Bot 配置页同构（独立插件）。**这一行就是「装不装」的开关**：
            // 注释掉 ⇒ listPages 里没有 bot-config ⇒ nav 里没有「Bot 配置」。
            // 测试对话用内存会话（@diy-agent/session-store-memory），说完不落盘。
            id: "bot-config-page",
            type: "module",
            data: { module: botConfigPageMain },
            config: homeConfig(),
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

/** 模型配置页只认数据根（`$DIY_HOME`）；缺席时页面方法会明确报错，不猜路径。 */
function homeConfig(): unknown {
    const home = process.env["DIY_HOME"];
    return home ? { home } : {};
}
