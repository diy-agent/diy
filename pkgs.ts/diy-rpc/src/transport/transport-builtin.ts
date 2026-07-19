import type { Transport, Envelope } from "./types";

export type TransportLogHandler = (dir: "recv" | "send", envelope: unknown) => void;

export function createLoggedTransport(
  tx: Transport,
  log: TransportLogHandler,
): Transport {
  tx.on((msg: unknown) => log("recv", msg));

  return {
    send: (payload) => {
      log("send", payload);
      tx.send(payload);
    },
    on: (h) => tx.on(h),
    onClose: (cb) => tx.onClose(cb),
  };
}

export function createMemTransportPair(): {
  serverTx: Transport;
  clientTx: Transport;
} {
  const qServer: unknown[] = [];
  const qClient: unknown[] = [];
  const serverListeners = new Set<(msg: Envelope) => void>();
  const clientListeners = new Set<(msg: Envelope) => void>();

  function drain() {
    while (qServer.length > 0) {
      const msg = qServer.shift()!;
      for (const h of clientListeners) h(msg as Envelope);
    }
    while (qClient.length > 0) {
      const msg = qClient.shift()!;
      for (const h of serverListeners) h(msg as Envelope);
    }
    if (qServer.length > 0 || qClient.length > 0) setImmediate(drain);
  }

  return {
    serverTx: {
      send(p: unknown) {
        qServer.push(p);
        setImmediate(drain);
      },
      on(h: (msg: Envelope) => void) {
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
        setImmediate(drain);
      },
      on(h: (msg: Envelope) => void) {
        clientListeners.add(h);
        return () => clientListeners.delete(h);
      },
      onClose() {
        return () => {};
      },
    },
  };
}
