/**
 * 04-cancel — 取消：客户端 abort，服务端收到 signal.aborted
 *
 * 为什么重要：长任务 / 流式卡住时，「停止」必须真的传到对面 ——
 * 否则服务端继续烧 CPU，客户端只能假装停了。
 */
import { z } from "zod";
import { RpcSchema, defineService, ChannelServerBinding, ChannelClientBinding } from "../../src/index";
import { createMemTransportPair } from "../../test/helpers";

const routes = RpcSchema.group({ children: {
    slow: RpcSchema.unary({
        input: { ms: z.number() },
        output: z.string(),
    }),
} });
const service = defineService({ name: "demo.slow", api: routes });

async function main(): Promise<void> {
    const [txs, txc] = createMemTransportPair();
    let serverSawAbort = false;

    service.bind(new ChannelServerBinding(txs), {
        slow: async ({ input, signal }) => {
            // 服务端要自己检查 signal —— 框架不会强杀你的 await
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, input.ms);
                signal.addEventListener("abort", () => {
                    clearTimeout(timer);
                    serverSawAbort = true;
                    resolve();
                }, { once: true });
            });
            return `等了 ${input.ms}ms`;
        },
    });

    const c = service.use(new ChannelClientBinding(txc));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    try {
        const r = await c.slow({ ms: 10_000 }, { signal: ac.signal });
        console.log("结果:", r);
    } catch (e) {
        console.log("客户端收到取消:", (e as Error).name);
    }
    // 等一拍让 abort 消息传过去
    await new Promise((r) => setTimeout(r, 200));
    console.log("服务端观察到 abort:", serverSawAbort);
}

void main();
