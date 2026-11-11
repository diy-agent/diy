/**
 * 02-stream/run.ts
 *
 *   npx tsx pkgs.ts/core/rpc/examples/service/02-stream/run.ts
 */
import { ChannelServerBinding, ChannelClientBinding, createScopedClient } from '../../../src/index';
import { createMemTransportPair } from '../../../test/helpers';
import { jobRoutes } from './src/api';

async function main(): Promise<void> {
  const [txServer, txClient] = createMemTransportPair();
  new ChannelServerBinding(txServer).use({
    prefix: 'demo',
    api: jobRoutes,
    handlers: {
      job: {
        // serverStream 的 handler 返回 AsyncGenerator<块>
        progress: async function* ({ input, signal }) {
          for (let i = 1; i <= input.total; i++) {
            if (signal.aborted) return; // 客户端断了就别再算
            await new Promise((r) => setTimeout(r, 30));
            yield { done: i, text: `第 ${i}/${input.total} 步` };
          }
        },
      },
    },
  });

  const job = createScopedClient({
    api: jobRoutes,
    client: new ChannelClientBinding(txClient),
    prefix: 'demo',
  });
  // ⚠️ serverStream 是 async 方法：先 await 拿句柄，再 for await
  const stream = await job.job.progress({ total: 3 });
  for await (const chunk of stream) {
    console.log(`[${chunk.done}/${3}] ${chunk.text}`);
  }
  console.log('流结束');
}

void main();
