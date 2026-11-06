/**
 * 04-group-root/run.ts
 *
 *   npx tsx pkgs.ts/core/rpc/examples/service/04-group-root/run.ts
 */
import { ChannelServerBinding, ChannelClientBinding } from "../../../src/index";
import { createMemTransportPair } from "../../../test/helpers";
import { calcService } from "./src/api";

async function main(): Promise<void> {
    const [txServer, txClient] = createMemTransportPair();

    // group 树能直接 bind（以前会推成 never、类型报错）
    calcService.bind(new ChannelServerBinding(txServer), {
        math: {
            add: ({ input }) => input.a + input.b,
            version: () => "2.0.0",
        },
    });

    const calc = calcService.use(new ChannelClientBinding(txClient));
    console.log("2 + 3 =", await calc.math.add({ a: 2, b: 3 }));
    console.log("version =", await calc.math.version({}));
}

void main();
