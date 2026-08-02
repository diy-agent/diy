import { contextBridge, ipcRenderer } from "electron";
import { createRendererTransport } from "@diy/rpc-transport-electron";

const transport = createRendererTransport();

contextBridge.exposeInMainWorld("transport", transport);

