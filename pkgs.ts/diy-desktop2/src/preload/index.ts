import { contextBridge, ipcRenderer } from "electron";
import { createRendererTransport } from "@diy/rpc-transport-electron";

const transport = createRendererTransport();

contextBridge.exposeInMainWorld("transport", transport);

contextBridge.exposeInMainWorld("diy", {
  // UI 命令推送（从 main → renderer）
  onUiCommand: (cb: (cmd: unknown) => void) => {
    const handler = (_e: unknown, cmd: unknown) => cb(cmd);
    ipcRenderer.on("ui:command", handler);
    return () => ipcRenderer.removeListener("ui:command", handler);
  },
});
