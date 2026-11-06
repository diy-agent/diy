/**
 * 03-stream — 服务端流：handler 返 AsyncGenerator，客户端 for await 消费
 *
 * 为什么用它：长任务的**增量**（进度 / 逐块结果），而不是等整轮跑完拿快照。
 */
import { z } from "zod";
import { RpcSchema, defineService, ChannelServerBinding, ChannelClientBinding } from "../src/index";
import { createMemTransportPair } from "../test/helpers";

const routes = RpcSchema.router({
    job: RpcSchema.router({
        /** 逐行吐进度；output 是**每一块**的类型（不是最终结果） */
        progress: RpcSchema.serverStream({
            input: { total: z.number() },
            output: z.object({ done: z.number(), text: z.string() }),
        }),
    }),
});
const service = defineService({ name: "demo.job", api: routes });

async function main(): Promise<void> {
    const [txs, txc] = createMemTransportPair();
    service.bind(new ChannelServerBinding(txs), {
        job: {
            // 注意：serverStream 的 handler 返回 AsyncGenerator<块>
            progress: async function* ({ input, signal }) {
                for (let i = 1; i <= input.total; i++) {
                    if (signal.aborted) return;           // ← 客户端断了就别再算
                    await new Promise((r) => setTimeout(r, 50));
                    yield { done: i, text: `第 ${i}/${input.total} 步` };
                }
            },
        },
    });

    const c = service.use(new ChannelClientBinding(txc));
    // ⚠️ serverStream 是 async 方法（要先 await 拿到句柄），不是直接可迭代
    const stream = await c.job.progress({ total: 3 });
    for await (const chunk of stream) {
        console.log("收到:", chunk.done, chunk.text);
    }
    console.log("流结束");
}

void main();
