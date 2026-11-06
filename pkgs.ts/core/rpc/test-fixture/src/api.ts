// 测试用 fixture：验证 gen-service-types 的扫描 + 生成 + --check
import { z } from 'zod';
import { RpcSchema } from '@diy-agent/rpc';

export const demoApi = RpcSchema.bindNames(RpcSchema.group({ children: {
    math: RpcSchema.group({ children: {
        add: RpcSchema.unary({
            input: { a: z.number(), b: z.number() },
            output: z.number(),
            desc: "a + b",
        }),
    } }),
    sys: RpcSchema.group({ children: {
        ping: RpcSchema.unary({ input: {}, output: z.string() }),
    } }),
} }));
