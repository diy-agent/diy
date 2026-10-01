import type { _Envelope } from '../src/core/types';

/**
 * 剩余项探针：notify 的协议/类型/实现是否一致。
 *
 * 事实判据（只看当前 HEAD 的真实行为，不猜设计意图）：
 * 1. types.ts 文档注释是否声称支持 `notify`；
 * 2. `_Envelope` 联合类型是否含 notify 成员（编译期可判定，这里以运行时反查替代）；
 * 3. Channel 收到 `{type:'notify'}` 时是否崩溃（应静默忽略，与未知帧同处理）。
 */
async function main() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const typesPath = path.resolve(import.meta.dirname, '../src/core/types.ts');
  const src = fs.readFileSync(typesPath, 'utf8');
  const documentedNotify = /type:\s*'notify'/.test(src);
  const notifyInUnion = /_\s*NotifyMsg|NotifyMsg/.test(src);
  const cancelInUnion = /type:\s*'cancel'/.test(src);

  const { ChannelClientBinding } = await import('../src/core/channel-client-binding');
  const { createMemTransportPair } = await import('../test/helpers');
  const [serverTx, clientTx] = createMemTransportPair();
  const client = new ChannelClientBinding(clientTx);

  let uncaught = '';
  const onUncaught = (e: unknown) => { uncaught = String((e as any)?.message ?? e); };
  process.once('uncaughtException', onUncaught);

  let outcome = 'ignored';
  try {
    serverTx.send({ type: 'notify', method: 'ping', params: {} } as unknown as _Envelope);
    await new Promise((r) => setTimeout(r, 30));
  } catch (e: any) {
    outcome = `threw:${e?.message}`;
  }

  console.log('[notify-matrix]', { documentedNotify, notifyInUnion, cancelInUnion, outcome, uncaught });

  if (documentedNotify && !notifyInUnion) {
    console.error('FAIL: protocol doc claims `notify` but envelope union has no notify member');
    process.exitCode = 1;
  } else if (uncaught) {
    console.error('FAIL: notify frame caused uncaught exception');
    process.exitCode = 1;
  } else {
    console.log('PASS: notify handling consistent with protocol/type definition');
  }

  process.removeListener('uncaughtException', onUncaught);
  client.dispose();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
