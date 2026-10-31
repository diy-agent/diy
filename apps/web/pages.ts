// pages.ts — 页面宿主：把插件清单装成 { list, invoke }，与 Electron 壳里的 page:invoke 同形。
//
// 装配复用了 apps/chat 的两块现成能力（**页面代码一行不改**）：
//   · 页面插件：`@diy-agent/chat-page/main`（它只认注入的 ChatSessionHost 端口）
//   · 多会话宿主：`@diy-agent/app-chat/sessions` 的 createChatSessions({ home })
//     （会话落盘 / 模型目录 / 真 provider 都在那里；本文件不碰文件系统与 key）
//
// 装配器用 `@diy-agent/workbench/loader`（纯装配，**不 import electron** —— 那是这个包
// 之所以单独导出 `./loader` 子路径的原因：`main` 入口要 electron，Node 侧起不来）。

import { createChatSessions } from '@diy-agent/app-chat/sessions';
import * as chatPageMain from '@diy-agent/chat-page/main';
import type { PageInfo, PageMethod } from '@diy-agent/workbench/page';
import { loadPages, type PluginEntry } from '@diy-agent/workbench/loader';
import type { LlmPort } from '@diy-agent/session';

/** 与 Electron 壳的 Workbench.invoke 同形（pageId + method + args） */
export interface PagesHost {
    list(): PageInfo[];
    invoke(pageId: string, method: string, args?: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface PagesOptions {
    /** 数据根（`$DIY_HOME`）：会话 / 模型配置都在它下面 */
    readonly home: string;
    /** 测试注入假 LLM（生产不传 = 真 provider，key 从 model.yaml 账号表取） */
    readonly llmFor?: (modelKey: string) => LlmPort;
}

/**
 * 装插件 → 页面方法表。
 *
 * 懒装配：`loadPages` 只归一插件贡献，不打开会话（会话宿主自己是懒的，第一次 snapshot 才读盘）。
 */
export async function createPagesHost(options: PagesOptions): Promise<PagesHost> {
    const plugins: PluginEntry[] = [
        {
            id: 'chat-page',
            type: 'module',
            data: { module: chatPageMain },
            config: {
                sessions: createChatSessions(
                    options.llmFor === undefined
                        ? { home: options.home }
                        : { home: options.home, llmFor: options.llmFor },
                ),
            },
        },
    ];

    const contributions = await loadPages(plugins);
    const byId = new Map(contributions.map((page) => [page.id, page]));

    return {
        list: () => contributions.map(({ id, title }) => ({ id, title })),

        async invoke(pageId, method, args, signal): Promise<unknown> {
            const page = byId.get(pageId);
            if (page === undefined) throw new Error(`没有这个页面：${pageId}`);
            const methods: Readonly<Record<string, PageMethod>> = page.methods ?? {};
            const fn = methods[method];
            if (typeof fn !== 'function') throw new Error(`页面 ${pageId} 没有方法 ${method}`);
            // 页面方法签名只有 args；取消信号由 RPC 绑定透传到这里（本轮页面方法都不用，留痕）
            void signal;
            return fn(args);
        },
    };
}
