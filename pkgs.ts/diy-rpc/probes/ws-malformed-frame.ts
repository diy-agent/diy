import { WebSocketServer, WebSocket } from 'ws';
import { WsTransport } from '../src/transport/ws';

async function main() {
  const port = 19800 + Math.floor(Math.random() * 500);
  const server = new WebSocketServer({ port });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => socket.once('open', () => resolve()));
  const transport = new WsTransport(socket as any);
  let closed = false;
  transport.onClose(() => { closed = true; });
  let uncaught: unknown;
  const onUncaught = (error: unknown) => { uncaught = error; };
  process.once('uncaughtException', onUncaught);
  try {
    socket.send('not-json');
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log('[ws-malformed-frame]', { closed, uncaught: String((uncaught as any)?.message ?? uncaught ?? '') });
    if (uncaught) {
      console.error('FAIL: malformed WS frame escaped transport boundary');
      process.exitCode = 1;
    } else {
      console.log('PASS: malformed WS frame was contained');
    }
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
