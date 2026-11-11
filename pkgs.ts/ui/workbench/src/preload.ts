// preload.ts — preload 侧的装配逻辑（2026-11-05 B2）
//
// 抽到包里而不是留在 apps/chat：apps/chat 有「源码 ≤300 行」的硬判据（##505），
// 而且**装配逻辑本来就该在包里** —— 换一个宿主 app（web / minimal）不该重写一遍。
//
// 一个 transport 上挂两个 binding（rpc 支持双端同挂）：
//   ChannelClientBinding  → 页面调主进程（listPages / invoke）
//   ChannelServerBinding  → 主进程调页面（意图测试命令 fill / click / waitState / readState）
import { ChannelClientBinding, ChannelServerBinding, createScopedClient, createTypedClient } from '@diy-agent/rpc';
import type { EnvelopeTransport } from '@diy-agent/rpc';
import { rendererRoutes, workbenchRoutes } from './protocol.js';
import type { WorkbenchBridge } from './channels.js';

export interface PreloadBridge {
    /** 暴露到 `window.workbench` 的对象（形状不变，页面侧无感） */
    readonly bridge: WorkbenchBridge;
    /**
     * 页面注册命令处理器（意图测试用）。生产不调 = 主进程发命令时抛错，不进正常路径。
     */
    installCommandHandler(handler: (cmd: unknown) => Promise<unknown>): void;
}

/** 由 preload 用 `createRendererTransport(RPC_CHANNEL)` 造出的 transport 调进来 */
export function createPreloadBridge(transport: EnvelopeTransport): PreloadBridge {
    // 只取 workbench 这一个模块（前缀与主进程的 bind 同源，都来自 workbenchService）
    const cli = createScopedClient({
        api: workbenchRoutes,
        client: new ChannelClientBinding(transport),
        prefix: 'diy.ui.workbench',
    });
    let handle: ((cmd: unknown) => Promise<unknown>) | undefined;

    const forward = async (cmd: unknown): Promise<void> => {
        if (handle === undefined) throw new Error('renderer 还没注册意图测试钩子');
        await handle(cmd);
    };

    const server = new ChannelServerBinding(transport);
    // 一次注册整个模块（路径自动带 `diy.ui.renderer.` 前缀，与主进程的 use() 同源）
    server.use({
        prefix: 'diy.ui.renderer',
        api: rendererRoutes,
        handlers: {
            ui: {
                fill: ({ input }: any) => forward({ type: 'fill', ...input }),
                click: ({ input }: any) => forward({ type: 'click', ...input }),
                waitState: ({ input }: any) => forward({ type: 'waitState', ...input }),
                readState: ({ input }: any) => forward({ type: 'readState', ...input }),
            },
        },
    });

    return {
        bridge: {
            listPages: () => cli.page.list({}),
            invoke: (pageId, method, args) => cli.page.invoke({ pageId, method, args }),
        },
        installCommandHandler: (h) => {
            handle = h;
        },
    };
}
