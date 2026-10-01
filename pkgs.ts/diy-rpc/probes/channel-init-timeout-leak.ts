import { z } from 'zod';
import { RpcSchema, ChannelClientBinding, ChannelServerBinding } from '../src/index';
import type { EnvelopeTransport, _Envelope } from '../src/core/types';
import { createMemTransportPair } from '../test/helpers';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api = RpcSchema.router({
  tick: RpcSchema.serverStream({ input: {}, output: z.number() }),
});

function delayServerToClient(tx: EnvelopeTransport, delay: number): EnvelopeTransport {
  return {
    send(payload: unknown) {
      setTimeout(() => tx.send(payload), delay);
    },
    on(handler: (msg: _Envelope) => void) { return tx.on(handler); },
    onClose(handler: () => void) { return tx.onClose(handler); },
  };
}

async function main() {
  const [serverTx, clientTx] = createMemTransportPair();
  const server = new ChannelServerBinding(delayServerToClient(serverTx, 100));
  const client = new ChannelClientBinding(clientTx);
  const state = { started: false, finallyRan: false, aborted: false, yields: 0 };

  server.on(api.tick, async function* ({ signal }) {
    state.started = true;
    signal.addEventListener('abort', () => { state.aborted = true; }, { once: true });
    try {
      for (;;) {
        state.yields++;
        yield 1;
        await sleep(10);
      }
    } finally {
      state.finallyRan = true;
    }
  });

  try {
    let clientError = '';
    await client.serverStream('tick', { input: {}, meta: {} }, { timeout: 20 })
      .catch((error: any) => { clientError = String(error?.code ?? error); });
    await sleep(80); // ack 被延迟，服务端已经可能启动并持续产出
    console.log('[channel-init-timeout]', { clientError, ...state });
    const leaked = state.started && !state.aborted && !state.finallyRan && state.yields > 0;
    if (leaked) {
      console.error('FAIL: init timeout rejected locally but server stream kept running');
      process.exitCode = 1;
    } else {
      console.log('PASS: init timeout cancelled server stream');
    }
  } finally {
    server.destroy();
    client.dispose();
    await sleep(100);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
