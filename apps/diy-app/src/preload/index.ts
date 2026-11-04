import { contextBridge } from "electron";
import { createRendererTransport } from "@diy-agent/rpc/electron/renderer";

const transport = createRendererTransport();

contextBridge.exposeInMainWorld("transport", transport);

