import { WebSocketServer, WebSocket } from 'ws';
import { WsTransport } from '../src/transport/ws';

/**
 * 候选 bug 探针：WS 关闭后 send 是否有守卫、是否抛错/逃逸。
 * 现状：send() 直接 this.ws.send(...)，无 readyState 检查、无 try/catch。
 */
async function main() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r) => socket.once('open', () => r()));
  const transport = new WsTransport(socket as any);

  // 对端下发坏帧 → _shutdown()（关闭终态）
  server.clients.forEach((p) => p.send('not-json'));
  await new Promise((r) => setTimeout(r, 120));

  let outcome = 'noop';
  try { transport.send({ type: 'call', id: 1, method: 'x' }); }
  catch (e: any) { outcome = `threw:${e?.name}:${e?.message}`; }

  console.log('[ws-send-after-shutdown]', { outcome });
  if (outcome.startsWith('threw')) {
    console.error('FAIL: WsTransport.send() throws after transport closed (no readyState guard)');
    process.exitCode = 1;
  } else {
    console.log('PASS: send after close is a no-op');
  }

  socket.close();
  await new Promise<void>((r) => server.close(() => r()));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
