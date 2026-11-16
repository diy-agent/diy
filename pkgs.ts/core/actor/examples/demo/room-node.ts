// room-node.ts — 房间节点（独立进程）。它多一样东西：**扇出端口**。
//
//   DIY_DEMO_ROOM_SOCKET=/tmp/x/room.sock \
//   DIY_DEMO_ROOM_URI=diy://demo/room \
//   DIY_DEMO_ROOM_DATA=/tmp/x/data/room \
//   node --import tsx examples/demo/room-node.ts
//
// 注意它**不认识**成员节点：`roster` 要问谁，是从自己的 state（members[].target）算出来的，
// 端口只负责按地址拨号（docs/05「摆放知识只属于 actor」）。

import { createSocketPort, serveActor } from '../lib/serve.js';
import { roomKind } from './kinds.js';

const socket = process.env['DIY_DEMO_ROOM_SOCKET'];
const uri = process.env['DIY_DEMO_ROOM_URI'];
const dataDir = process.env['DIY_DEMO_ROOM_DATA'];

if (!socket || !uri) {
    console.error('[room] 缺 DIY_DEMO_ROOM_SOCKET / DIY_DEMO_ROOM_URI');
    process.exit(2);
}

const port = createSocketPort({ timeoutMs: 2_000 });

const served = await serveActor({
    kind: roomKind,
    uri,
    socket,
    port,
    // 成员节点拨不通是**正常情况**（它就是掉线），别把它当房间自己出错
    onLog: (event) => console.error(`[${uri}] ${event.level}: ${event.message}`),
    ...(dataDir ? { dataDir } : {}),
});

console.error(`[${uri}] listening ${socket}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        void served.close().then(() => process.exit(0));
    });
}
