// index.ts — profile：这份 app 装哪些页面，只由这一份 TS 决定（不用 json 配置）。
//
// ##458 的裁决：插件引用 = **直接 import**，不是字符串包名。
//   现在：`import * as chatPageMain from "@diy-agent/chat-page/main"` → tsc 检查包存在、
//        导出类型也一起进来；包名写错一个字母就是编译错，不必等到起窗口。
//   以前：`{ id, name: "@diy-agent/chat-page/main" }` + 运行时 dynamic import → 只有运行时才知道。
//
// 外壳（@diy-agent/workbench）+ 骨架（@diy-agent/workbench-ui）都不认识具体页面，页面由这里带进来。

import * as chatPageMain from "@diy-agent/chat-page/main";
import { openJsonlSessionStore, type JsonlSessionStore } from "@diy-agent/session-store-jsonl";
import type { SessionStore } from "@diy-agent/session";
import { join } from "node:path";
import { DEFAULT_MODEL_ID, createOpenAiCompatible, type LlmProvider } from "@diy-agent/llm-provider";
import type { PluginEntry } from "@diy-agent/workbench";
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
            config: { llm: llmFromEnv(), store: sessionStoreFromEnv() },
        },
    ],
};

/**
 * 会话落盘：`$DIY_HOME/sessions/chat-page/**`（判据见 ##461 —— 「Session 真的工作了」要看得到 jsonl）。
 *
 * 懒打开：profile 在模块求值时就被 main.ts 导入，那时 `app.whenReady()` 还没到、
 * 也不该在启动路径上做同步 IO；第一次 append 才 open，失败只影响落盘不影响对话。
 * `DIY_HOME` 缺席（如被当纯库 import）= 不传 store，行为退回纯内存。
 */
function sessionStoreFromEnv(): SessionStore | undefined {
    const home = process.env["DIY_HOME"];
    if (!home) return undefined;
    let opening: Promise<JsonlSessionStore> | undefined;
    const open = (): Promise<JsonlSessionStore> =>
        (opening ??= openJsonlSessionStore({ dir: join(home, "sessions", "chat-page") }));
    return {
        append: async (messages) => (await open()).append(messages),
        readFrom: async (seq) => (await open()).readFrom(seq),
        readRange: async (range) => (await open()).readRange(range),
        latestSeq: async () => (await open()).latestSeq(),
    };
}

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
    // 额外 header（JSON）：有些 provider 要求非标准头，比如 opencode 的
    // `x-opencode-session`（缺了直接 400 MissingSessionID）
    const rawHeaders = process.env["LLM_HEADERS"];
    return createOpenAiCompatible({
        baseURL,
        apiKey,
        model: process.env["LLM_MODEL"] ?? DEFAULT_MODEL_ID,
        ...(rawHeaders === undefined ? {} : { headers: JSON.parse(rawHeaders) as Record<string, string> }),
    });
}
