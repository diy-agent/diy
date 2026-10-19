import { contextBridge } from "electron";
import { createRendererTransport } from "@diy-agent/rpc/electron";

const transport = createRendererTransport();

contextBridge.exposeInMainWorld("transport", transport);

