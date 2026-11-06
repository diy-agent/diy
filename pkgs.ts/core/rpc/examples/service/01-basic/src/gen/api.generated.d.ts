// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）
// 源：MathApi
import type { RpcCallOptions } from '@diy-agent/rpc';

// ⚠️ 模块名 / 方法路径是**跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。

/** Math 的**客户端**形状 */
export interface MathClient {
    math: {
        /** a + b */
        add(input: { a: number; b: number }, options?: RpcCallOptions): Promise<number>;
        version(input: Record<string, never>, options?: RpcCallOptions): Promise<string>;
    };
}

/** Math 的**服务端**形状 */
export interface MathServer {
    math: {
        /** a + b */
        add(opts: { input: { a: number; b: number }; signal: AbortSignal }): number | Promise<number>;
        version(opts: { input: Record<string, never>; signal: AbortSignal }): string | Promise<string>;
    };
}
