// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）
// 源：DemoApi
import type { RpcCallOptions } from '@diy-agent/rpc';

// ⚠️ 模块名 / 方法路径是**跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。

/** Demo 的**客户端**形状 */
export interface DemoClient {
    math: {
        /** a + b */
        add(input: { a: number; b: number }, options?: RpcCallOptions): Promise<number>;
    };

    sys: {
        ping(input: Record<string, never>, options?: RpcCallOptions): Promise<string>;
    };
}

/** Demo 的**服务端**形状 */
export interface DemoServer {
    math: {
        /** a + b */
        add(opts: { input: { a: number; b: number }; signal: AbortSignal }): number | Promise<number>;
    };

    sys: {
        ping(opts: { input: Record<string, never>; signal: AbortSignal }): string | Promise<string>;
    };
}
