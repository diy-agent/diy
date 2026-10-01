import { ChannelClientBinding } from '../src/core/channel-client-binding';
import { ChannelServerBinding } from '../src/core/channel-server-binding';
import { createMemTransportPair } from '../test/helpers';

/**
 * 候选未结项探针（185 待办 #4）：channel 未注册方法 / mode 不匹配是否返回错误。
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [serverTx, clientTx] = createMemTransportPair();
  const server = new ChannelServerBinding(serverTx);
  const client = new ChannelClientBinding(clientTx);

  let outcome = 'HUNG';
  try {
    await client.invoke('diy.not.registered', { input: {}, meta: {} }, { timeout: 300 });
    outcome = 'resolved';
  } catch (e: any) {
    outcome = `rejected:${e?.code}`;
  }
  console.log('[channel-unknown-method]', { outcome });

  server.destroy();
  client.dispose();
  await sleep(20);

  if (outcome === 'HUNG') {
    console.error('FAIL: unknown method never settled (no error frame)');
    process.exitCode = 1;
  } else if (outcome === 'rejected:UNIMPLEMENTED') {
    console.log('PASS: unknown method → UNIMPLEMENTED');
  } else {
    console.log(`NOTE: unknown method → ${outcome}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
