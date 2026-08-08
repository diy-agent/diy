import { contextBridge } from "electron";
import { createRendererTransport } from "@diy/rpc/electron";

const transport = createRendererTransport();

contextBridge.exposeInMainWorld("transport", transport);

