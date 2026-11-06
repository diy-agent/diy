// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）
// 源：TaskApi
import type { RpcCallOptions } from '@diy-agent/rpc';

// ⚠️ 模块名 / 方法路径是**跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。

/** Task 的**客户端**形状 */
export interface TaskClient {
    task: {
        /** 列任务 */
        list(input: { status?: "pending" | "done"; limit?: number }, options?: RpcCallOptions): Promise<{ uri: string; title: string; done: boolean }[]>;
        get(input: { uri: string }, options?: RpcCallOptions): Promise<{ uri: string; title: string; done: boolean }>;
    };
}

/** Task 的**服务端**形状 */
export interface TaskServer {
    task: {
        /** 列任务 */
        list(opts: { input: { status?: "pending" | "done"; limit?: number }; signal: AbortSignal }): { uri: string; title: string; done: boolean }[] | Promise<{ uri: string; title: string; done: boolean }[]>;
        get(opts: { input: { uri: string }; signal: AbortSignal }): { uri: string; title: string; done: boolean } | Promise<{ uri: string; title: string; done: boolean }>;
    };
}
