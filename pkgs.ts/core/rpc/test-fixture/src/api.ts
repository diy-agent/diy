// 测试用 fixture：验证 gen-service-types 的扫描 + 生成 + --check
import { z } from 'zod';
import { RpcSchema } from '@diy-agent/rpc';

export const demoApi = RpcSchema.router({
    math: RpcSchema.router({
        add: RpcSchema.unary({
            input: { a: z.number(), b: z.number() },
            output: z.number(),
            desc: "a + b",
        }),
    }),
    sys: RpcSchema.router({
        ping: RpcSchema.unary({ input: {}, output: z.string() }),
    }),
});
