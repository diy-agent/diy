import type { EnvelopeTransport } from "@diy-agent/rpc";
import { createTypedClient, ChannelClientBinding } from "@diy-agent/rpc";
import { apiDef } from "../../main/services/api-def";

declare global {
  interface Window {
    transport: EnvelopeTransport;
  }
}
export const diyService = createTypedClient(new ChannelClientBinding(window.transport), apiDef);
