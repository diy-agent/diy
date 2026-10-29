// index.ts — profile：这份 app 装哪些页面，只由这一份 TS 决定（不用 json 配置）。
//
// ##458 的裁决：插件引用 = **直接 import**，不是字符串包名。
//   现在：`import * as chatPageMain from "@diy/chat-page/main"` → tsc 检查包存在、
//        导出类型也一起进来；包名写错一个字母就是编译错，不必等到起窗口。
//   以前：`{ id, name: "@diy/chat-page/main" }` + 运行时 dynamic import → 只有运行时才知道。
//
// 外壳（@diy/workbench）+ 骨架（@diy/ui-workbench）都不认识具体页面，页面由这里带进来。

import * as chatPageMain from "@diy/chat-page/main";
import { DEFAULT_MODEL_ID, createOpenAiCompatible, type LlmProvider } from "@diy/llm-provider";
import type { PluginEntry } from "@diy/workbench";
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
            // 有完整 LLM_* 环境变量 ⇒ 真 provider；缺一个 ⇒ 不传，插件退回假回复（##457 行为不变）
            config: { llm: llmFromEnv() },
        },
    ],
};

/**
 * 从环境拿连接信息建 provider（配置**全部外部传入**，provider 自己不读任何东西）。
 *
 * 为什么在 profile 里读 env、而不在 provider 包里读：读环境 / 读数据根是**宿主**的事，
 * provider 只认一份显式配置 —— 这样它才能在测试里被一个假 fetch 完全驱动。
 */
function llmFromEnv(): LlmProvider | undefined {
    const baseURL = process.env["LLM_BASE_URL"];
    const apiKey = process.env["LLM_API_KEY"];
    if (!baseURL || !apiKey) return undefined;
    return createOpenAiCompatible({
        baseURL,
        apiKey,
        model: process.env["LLM_MODEL"] ?? DEFAULT_MODEL_ID,
    });
}
