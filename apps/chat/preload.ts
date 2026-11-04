// preload.ts — 唯一一座桥。装配逻辑在 @diy-agent/workbench/preload（apps/chat 要薄）。
// 2026-11-04（B1）手写 IPC → @diy-agent/rpc；2026-11-05（B2）加 main → renderer 的命令通道。
import { contextBridge } from "electron";
import { createRendererTransport } from "@diy-agent/rpc/electron/renderer";
import { RPC_CHANNEL } from "@diy-agent/workbench/channels";
import { createPreloadBridge } from "@diy-agent/workbench/preload";

const pb = createPreloadBridge(createRendererTransport(RPC_CHANNEL));
contextBridge.exposeInMainWorld("workbench", pb.bridge);
// 意图测试钩子：页面把自己的命令处理器挂进来（生产不调 = 零开销）
contextBridge.exposeInMainWorld("__diyTestHooks", { setHandler: (h: (cmd: unknown) => Promise<unknown>) => pb.installCommandHandler(h) });
