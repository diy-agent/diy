import type { EnvelopeTransport } from "@diy/rpc";
import { createTypedClient, ChannelClientBinding } from "@diy/rpc";
import { apiDef } from "../../../main/services/api-def";

declare global {
  interface Window {
    transport: EnvelopeTransport;
  }
}

/** Renderer → Main 进程 RPC 客户端（强类型，从 apiDef 的 zod schema 推导） */
export const diyService = createTypedClient(new ChannelClientBinding(window.transport), apiDef);
