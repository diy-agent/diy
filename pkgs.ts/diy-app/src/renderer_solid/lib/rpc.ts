import type { EnvelopeTransport } from "@diy-agent/rpc";
import { createTypedClient, ChannelClientBinding } from "@diy-agent/rpc";
import { apiDef } from "../../main/services/api-def";

declare global {
  interface Window {
    transport: EnvelopeTransport;
  }
}

/**
 * renderer 侧唯一的 RPC 客户端（**懒建 + 可注入**，##402）。
 *
 * 为什么不是一行 `export const diyService = createTypedClient(...)`：
 *   · **懒建**：模块求值不再依赖 `window.transport`（node 单测里 import 这个模块不炸）。
 *   · **可注入**：单测要换成假实现，旧做法 `vi.mock("renderer_solid/lib/rpc")` 改的是
 *     **全局模块表** —— `isolate:false` 下谁先加载了真实现，mock 就静默失效（测试对错取决于
 *     文件落进哪个 worker / 什么顺序）。这里把「用哪个 client」变成模块内可写状态，由测试
 *     显式调用 `setDiyService(...)`；生产路径零感知（没人调它 = 首次访问时懒建真实现）。
 *
 * 生产语义不变：仍是 `createTypedClient(new ChannelClientBinding(window.transport), apiDef)`，
 * 只是推迟到**第一次用**时才建（renderer 里此时 window.transport 一定已就绪）。
 */
function createRealService() {
  return createTypedClient(new ChannelClientBinding(window.transport), apiDef);
}

type DiyService = ReturnType<typeof createRealService>;

let impl: DiyService | null = null;

/**
 * 稳定的客户端门面：所有调用点仍写 `diyService.diy.…`，转发到当前实现。
 * 用 Proxy 而不是每次调用 `getDiyService()`：15+ 个调用点不必改，且属性访问语义不变。
 */
export const diyService: DiyService = new Proxy({} as DiyService, {
  get(_target, prop) {
    const svc = (impl ??= createRealService()) as Record<string | symbol, unknown>;
    const v = svc[prop];
    return typeof v === "function" ? v.bind(svc) : v;
  },
});

/**
 * 换掉底层实现（**仅测试用**）。传 `null` = 回到懒建真实现。
 * 名字不带 `ForTest`：`rpc` 模块本身就是"该被换掉的边界"，与 `setWriteErrorHook` 同风格。
 */
export function setDiyService(svc: DiyService | null): void {
  impl = svc;
}
