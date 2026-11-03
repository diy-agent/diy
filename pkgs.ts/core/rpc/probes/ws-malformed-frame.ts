import { WebSocketServer, WebSocket } from 'ws';
import { WsTransport } from '../src/transport/ws';

async function main() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => socket.once('open', () => resolve()));

  const transport = new WsTransport(socket as any);
  let closed = false;
  let received = 0;
  let errorEvents = 0;
  transport.onClose(() => { closed = true; });
  transport.on(() => { received++; });
  socket.on('error', () => { errorEvents++; });

  let uncaught = '';
  const onUncaught = (error: unknown) => { uncaught = String((error as any)?.message ?? error); };
  process.once('uncaughtException', onUncaught);

  let settled: unknown = 'none';
  try {
    // 关键：坏帧必须由**对端**下发，才会进入 WsTransport 的 JSON.parse
    server.clients.forEach((peer) => peer.send('not-json'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    settled = { closed, received, errorEvents, uncaught };
    console.log('[ws-malformed-frame]', settled);
    if (uncaught) {
      console.error('FAIL: malformed WS frame escaped transport boundary (uncaught)');
      process.exitCode = 1;
    } else if (!closed) {
      console.error('FAIL: malformed WS frame neither closed transport nor raised error');
      process.exitCode = 1;
    } else {
      console.log('PASS: malformed WS frame closed the transport without crashing the process');
    }
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
