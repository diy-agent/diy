// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）
// 源：CalcApi
import type { RpcCallOptions } from '@diy-agent/rpc';

// ⚠️ 模块名 / 方法路径是**跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。

/** Calc 的**客户端**形状 */
export interface CalcClient {
    math: {
        /** 两数相加 */
        add(input: { a: number; b: number }, options?: RpcCallOptions): Promise<number>;
        /** 版本号 */
        version(input: Record<string, never>, options?: RpcCallOptions): Promise<string>;
    };
}

/** Calc 的**服务端**形状 */
export interface CalcServer {
    math: {
        /** 两数相加 */
        add(opts: { input: { a: number; b: number }; signal: AbortSignal }): number | Promise<number>;
        /** 版本号 */
        version(opts: { input: Record<string, never>; signal: AbortSignal }): string | Promise<string>;
    };
}
