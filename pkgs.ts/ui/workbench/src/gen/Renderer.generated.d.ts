// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）
// 源：RendererApi
import type { RpcCallOptions } from '@diy-agent/rpc';

// ⚠️ 模块名 / 方法路径是**跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。

/** Renderer 的**客户端**形状 */
export interface RendererClient {
    ui: {
        fill(input: { selector: string; value: string }, options?: RpcCallOptions): Promise<unknown>;
        click(input: { selector: string }, options?: RpcCallOptions): Promise<unknown>;
        waitState(input: { path: string; equals: unknown; timeoutMs?: number }, options?: RpcCallOptions): Promise<unknown>;
        readState(input: { path: string }, options?: RpcCallOptions): Promise<unknown>;
    };
}

/** Renderer 的**服务端**形状 */
export interface RendererServer {
    ui: {
        fill(opts: { input: { selector: string; value: string }; signal: AbortSignal }): unknown | Promise<unknown>;
        click(opts: { input: { selector: string }; signal: AbortSignal }): unknown | Promise<unknown>;
        waitState(opts: { input: { path: string; equals: unknown; timeoutMs?: number }; signal: AbortSignal }): unknown | Promise<unknown>;
        readState(opts: { input: { path: string }; signal: AbortSignal }): unknown | Promise<unknown>;
    };
}
