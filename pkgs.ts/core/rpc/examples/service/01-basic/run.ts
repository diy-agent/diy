/**
 * 01-basic/run.ts —— 生成型的推荐写法
 *
 *   npx tsx pkgs.ts/core/rpc/examples/service/01-basic/run.ts
 */
import { ChannelServerBinding, ChannelClientBinding } from "../../../src/index";
import { createMemTransportPair } from "../../../test/helpers";
import { mathService } from "./src/api";

async function main(): Promise<void> {
    const [txServer, txClient] = createMemTransportPair();

    // 服务端：一次注册整个模块（handler 收 `{ input, signal }`）
    mathService.bind(new ChannelServerBinding(txServer), {
        math: {
            add: ({ input }) => input.a + input.b,
            version: () => "1.0.0",
        },
    });

    // 客户端：只拿这个模块（前缀与 bind 同源）
    const math = mathService.use(new ChannelClientBinding(txClient));
    console.log("2 + 3 =", await math.math.add({ a: 2, b: 3 }));
    console.log("version =", await math.math.version({}));
}

void main();
