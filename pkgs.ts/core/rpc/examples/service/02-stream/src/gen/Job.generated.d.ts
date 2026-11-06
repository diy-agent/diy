// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）
// 源：JobApi
import type { RpcCallOptions } from '@diy-agent/rpc';

// ⚠️ 模块名 / 方法路径是**跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。

/** Job 的**客户端**形状 */
export interface JobClient {
    job: {
        progress(input: { total: number }, options?: RpcCallOptions): Promise<{ done: number; text: string }>;
    };
}

/** Job 的**服务端**形状 */
export interface JobServer {
    job: {
        progress(opts: { input: { total: number }; signal: AbortSignal }): { done: number; text: string } | Promise<{ done: number; text: string }>;
    };
}
