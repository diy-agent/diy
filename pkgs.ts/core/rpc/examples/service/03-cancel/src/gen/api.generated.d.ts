// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）
// 源：SlowApi
import type { RpcCallOptions } from '@diy-agent/rpc';

// ⚠️ 模块名 / 方法路径是**跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。

/** Slow 的**客户端**形状 */
export interface SlowClient {
    slow(input: { ms: number }, options?: RpcCallOptions): Promise<string>;
}

/** Slow 的**服务端**形状 */
export interface SlowServer {
    slow(opts: { input: { ms: number }; signal: AbortSignal }): string | Promise<string>;
}
