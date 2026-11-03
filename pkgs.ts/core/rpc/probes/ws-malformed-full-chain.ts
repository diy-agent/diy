import { WebSocketServer, WebSocket } from 'ws';
import { ChannelClientBinding } from '../src/core/channel-client-binding';
import { WsTransport } from '../src/transport/ws';

/**
 * 剩余项探针（完整链路）：WS 对端下发坏帧时，上层 pending 调用与进程会发生什么。
 *
 * 旧 `ws-malformed-frame.ts` 从客户端 socket 发帧，传输侧从未 JSON.parse → 恒 PASS（假 PASS）。
 * 本探针覆盖真实链路：WsTransport → ChannelClientBinding.invoke 的 pending 调用。
 *
 * 判据：
 *   A. 进程是否 uncaughtException（生产无 handler 即崩溃）；
 *   B. pending 调用是否落定（坏帧后应尽快 DISPOSED/CANCELLED，不得永挂）。
 */
async function main() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => socket.once('open', () => resolve()));
  const client = new ChannelClientBinding(new WsTransport(socket as any));

  let uncaught = '';
  const onUncaught = (e: unknown) => { uncaught = String((e as any)?.message ?? e); };
  process.once('uncaughtException', onUncaught);

  let settled: unknown = 'HUNG';
  const call = client.invoke('diy.x.y', {}, { timeout: 5000 }).then(
    () => { settled = 'resolved'; },
    (e: any) => { settled = `rejected:${e?.code}`; },
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  server.clients.forEach((peer) => peer.send('not-json')); // 对端下发坏帧
  await new Promise((resolve) => setTimeout(resolve, 200));

  console.log('[ws-malformed-full-chain]', { uncaught: uncaught || '(none)', pending: settled });

  if (uncaught) {
    console.error('FAIL: malformed peer frame crashed the transport (uncaughtException)');
    process.exitCode = 1;
  } else if (settled === 'HUNG') {
    console.error('FAIL: pending call never settled after malformed frame');
    process.exitCode = 1;
  } else {
    console.log('PASS: malformed frame contained and pending call settled');
  }

  process.removeListener('uncaughtException', onUncaught);
  socket.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.race([call, new Promise((r) => setTimeout(r, 100))]);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
