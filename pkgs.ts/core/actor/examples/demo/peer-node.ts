// peer-node.ts — 一个成员节点（独立进程，只能通过 socket 被找到）。
//
//   DIY_DEMO_PEER_SOCKET=/tmp/x/peer-a.sock \
//   DIY_DEMO_PEER_URI=diy://demo/peer-a \
//   DIY_DEMO_PEER_DATA=/tmp/x/data/peer-a \
//   node --import tsx examples/demo/peer-node.ts
//
// 日志一律走 stderr：stdout 留给「帧」（真接 stdio 链路时，stdout 混进一行日志就是一条坏帧）。

import { serveActor } from '../lib/serve.js';
import { peerKind } from './kinds.js';

const socket = process.env['DIY_DEMO_PEER_SOCKET'];
const uri = process.env['DIY_DEMO_PEER_URI'];
const dataDir = process.env['DIY_DEMO_PEER_DATA'];

if (!socket || !uri) {
    console.error('[peer] 缺 DIY_DEMO_PEER_SOCKET / DIY_DEMO_PEER_URI');
    process.exit(2);
}

const served = await serveActor({
    kind: peerKind,
    uri,
    socket,
    ...(dataDir ? { dataDir } : {}),
    onLog: (event) => console.error(`[${uri}] ${event.message}`),
});

console.error(`[${uri}] listening ${socket}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        void served.close().then(() => process.exit(0));
    });
}
