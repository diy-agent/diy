/**
 * 03-cancel/run.ts
 *
 *   npx tsx pkgs.ts/core/rpc/examples/service/03-cancel/run.ts
 */
import { ChannelServerBinding, ChannelClientBinding } from "../../../src/index";
import { createMemTransportPair } from "../../../test/helpers";
import { slowService } from "./src/api";

let serverSawAbort = false;

async function main(): Promise<void> {
    const [txServer, txClient] = createMemTransportPair();
    slowService.bind(new ChannelServerBinding(txServer), {
        slow: async ({ input, signal }) => {
            // 框架**不会**强杀你的 await —— 要自己检查 signal
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, input.ms);
                signal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        serverSawAbort = true;
                        resolve();
                    },
                    { once: true },
                );
            });
            return `等了 ${input.ms}ms`;
        },
    });

    const slow = slowService.use(new ChannelClientBinding(txClient));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    try {
        console.log("结果:", await slow.slow({ ms: 10_000 }, { signal: ac.signal }));
    } catch (e) {
        console.log("客户端收到取消:", (e as Error).name);
    }
    await new Promise((r) => setTimeout(r, 200));
    console.log("服务端观察到 abort:", serverSawAbort);
}

void main();
