import { z } from 'zod';
import { RpcSchema } from '../src/index';
import { ChannelClientBinding } from '../src/core/channel-client-binding';
import { createMemTransportPair } from '../test/helpers';

/**
 * 候选未结项探针：协议健壮性边角（为子任务记录准确性而做）。
 * 1. send-after-close：传输关闭后 send 是否抛错逃逸（应为静默 no-op）
 * 2. 未知信封 type：是否崩溃（应忽略）
 * 3. 重复 end / data-after-end：是否崩溃
 */
const api = RpcSchema.router({
  ping: RpcSchema.unary({ input: {}, output: z.string() }),
});
void api;

async function main() {
  const [serverTx, clientTx] = createMemTransportPair();
  const client = new ChannelClientBinding(clientTx);
  let uncaught = '';
  const onUncaught = (e: unknown) => { uncaught = String((e as any)?.message ?? e); };
  process.once('uncaughtException', onUncaught);

  const results: Record<string, string> = {};

  // 1. 未知 type
  try { serverTx.send({ type: 'nope', x: 1 } as any); results.unknownType = 'ignored'; }
  catch (e: any) { results.unknownType = `threw:${e?.message}`; }

  // 2. data 指向不存在的 stream
  try { serverTx.send({ type: 'data', stream: 999, value: 1 } as any); results.staleData = 'ignored'; }
  catch (e: any) { results.staleData = `threw:${e?.message}`; }

  // 3. end 指向不存在的 stream + 重复
  try {
    serverTx.send({ type: 'end', stream: 999 } as any);
    serverTx.send({ type: 'end', stream: 999 } as any);
    results.staleEndDup = 'ignored';
  } catch (e: any) { results.staleEndDup = `threw:${e?.message}`; }

  // 4. send-after-dispose：dispose 后调用方 send 是否抛错
  client.dispose();
  let afterDispose = 'noop';
  try { clientTx.send({ type: 'call', id: 99, method: 'ping' }); results.sendAfterDispose = 'ok'; }
  catch (e: any) { afterDispose = `threw:${e?.message}`; results.sendAfterDispose = afterDispose; }

  await new Promise((r) => setTimeout(r, 30));
  console.log('[protocol-misc]', { ...results, uncaught: uncaught || '(none)' });
  process.removeListener('uncaughtException', onUncaught);
  console.log(uncaught ? 'FAIL: uncaught escaped protocol boundary' : 'PASS: protocol edge cases contained');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
