// preload.ts — 唯一一座桥：把 RPC client 包成 window.workbench。
// contextIsolation + sandbox 下 renderer 拿不到 Node，只能走这里。
// 2026-11-04（B1）：底层从手写 ipcRenderer.invoke 换成 @diy-agent/rpc；
// 对外形状（WorkbenchGateway 的 listPages / invoke）一行没变，所以页面侧不用改。
import { contextBridge } from "electron";
import { ChannelClientBinding, createTypedClient } from "@diy-agent/rpc";
import { createRendererTransport } from "@diy-agent/rpc/electron/renderer";
import { RPC_CHANNEL, type WorkbenchBridge } from "@diy-agent/workbench/channels";
import { workbenchApi } from "@diy-agent/workbench/protocol";

const cli = createTypedClient(new ChannelClientBinding(createRendererTransport(RPC_CHANNEL)), workbenchApi);

contextBridge.exposeInMainWorld("workbench", {
    listPages: () => cli.page.list({}),
    invoke: (pageId: string, method: string, args?: unknown) => cli.page.invoke({ pageId, method, args }),
} satisfies WorkbenchBridge);
