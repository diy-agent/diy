/**
 * helpers.ts — 测试公共工具
 *
 * createMemTransportPair：in-memory EnvelopeTransport 对，模拟内存直连（替代真实
 * Electron IPC / 网络）。channel harness 用它，其余 harness（http/ws）用自己的真实传输。
 */
import type { EnvelopeTransport } from '../src/core/types';

export function createMemTransportPair(): [EnvelopeTransport, EnvelopeTransport] {
  const qServer: unknown[] = [];    // server → client messages
  const qClient: unknown[] = [];    // client → server messages
  const serverListeners = new Set<Function>();
  const clientListeners = new Set<Function>();

  function drain() {
    while (qServer.length > 0) { const m = qServer.shift()!; for (const h of clientListeners) h(m); }
    while (qClient.length > 0) { const m = qClient.shift()!; for (const h of serverListeners) h(m); }
    if (qServer.length > 0 || qClient.length > 0) setImmediate(drain);
  }

  return [
    { send(p) { qServer.push(p); setImmediate(drain); }, on(h) { serverListeners.add(h); return () => serverListeners.delete(h); }, onClose() { return () => {}; } },
    { send(p) { qClient.push(p); setImmediate(drain); }, on(h) { clientListeners.add(h); return () => clientListeners.delete(h); }, onClose() { return () => {}; } },
  ];
}
