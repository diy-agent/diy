// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）
// 源：WorkbenchApi
import type { RpcCallOptions } from '@diy-agent/rpc';

// ⚠️ 模块名 / 方法路径是**跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。

/** Workbench 的**客户端**形状 */
export interface WorkbenchClient {
    page: {
        list(input: Record<string, never>, options?: RpcCallOptions): Promise<{ id: string; title: string; description?: string }[]>;
        invoke(input: { pageId: string; method: string; args?: unknown }, options?: RpcCallOptions): Promise<unknown>;
    };
}

/** Workbench 的**服务端**形状 */
export interface WorkbenchServer {
    page: {
        list(opts: { input: Record<string, never>; signal: AbortSignal }): { id: string; title: string; description?: string }[] | Promise<{ id: string; title: string; description?: string }[]>;
        invoke(opts: { input: { pageId: string; method: string; args?: unknown }; signal: AbortSignal }): unknown | Promise<unknown>;
    };
}
