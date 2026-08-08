import type { Transport, _Envelope } from "./types";

export function createMemTransportPair(): {
  serverTx: Transport;
  clientTx: Transport;
} {
  const qServer: unknown[] = [];
  const qClient: unknown[] = [];
  const serverListeners = new Set<(msg: _Envelope) => void>();
  const clientListeners = new Set<(msg: _Envelope) => void>();

  function drain() {
    while (qServer.length > 0) {
      const msg = qServer.shift()!;
      for (const h of clientListeners) h(msg as _Envelope);
    }
    while (qClient.length > 0) {
      const msg = qClient.shift()!;
      for (const h of serverListeners) h(msg as _Envelope);
    }
    if (qServer.length > 0 || qClient.length > 0) queueMicrotask(drain);
  }

  return {
    serverTx: {
      send(p: unknown) {
        qServer.push(p);
        queueMicrotask(drain);
      },
      on(h: (msg: _Envelope) => void) {
        serverListeners.add(h);
        return () => serverListeners.delete(h);
      },
      onClose() {
        return () => {};
      },
    },
    clientTx: {
      send(p: unknown) {
        qClient.push(p);
        queueMicrotask(drain);
      },
      on(h: (msg: _Envelope) => void) {
        clientListeners.add(h);
        return () => clientListeners.delete(h);
      },
      onClose() {
        return () => {};
      },
    },
  };
}
