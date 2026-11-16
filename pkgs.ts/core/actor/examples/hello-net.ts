// hello-net.ts — 入门二：**两个进程**，中间一条 unix socket。别的都不加（没有落盘、没有扇出）。
//
//   ./sha.sh hello-net      （等价于 node --import tsx examples/hello-net.ts）
//
// 父进程当调用方，起一个子进程当服务端；问完就收拾干净。
// 和入门一的差别只在接线那 3 行：createLocalActor 换成 serveActor + connectActor。

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from '../src/index.js';

import { counter } from './hello-counter.js';
import { connectActor, serveActor, waitForSocket } from './lib/serve.js';

// socket 路径由**父进程**定，再传给子进程：父子是两个进程、pid 不同，
// 各自用 process.pid 拼就会各听一个地方（这个坑第一版就踩了）。
const isServer = process.argv[2] === 'serve';

if (isServer) {
    // ── 服务端（子进程）───────────────────────────────────────────────
    // 给 kind + socket 就够：不用逐条绑方法（契约里已经有命令和查询了）。
    // 不给 dataDir = 内存 store —— 这个进程死了状态就没了（落盘见 demo/）。
    await serveActor({ kind: counter, uri: 'hello://counter', socket: process.argv[3]! });
    console.log('[server] 在听', process.argv[3]);
} else {
    // ── 调用方（父进程）───────────────────────────────────────────────
    const socket = path.join(os.tmpdir(), `hello-actor-${process.pid}.sock`);
    const child = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, 'serve', socket], {
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    try {
        await waitForSocket(socket); // 子进程起来要时间：拨通了才算好
        const client = await connectActor({ kind: counter, socket });

        // 三个动词和入门一**一模一样** —— 进程边界对业务代码是透明的。
        console.log('cmd   →', await client.cmd('add', { by: 3 }));
        console.log('query →', JSON.stringify(await client.query('get', {})));

        for await (const event of client.watch({ include: ['added'] })) {
            console.log('watch →', event.name, event.data, 'seq =', event.seq);
            break;
        }

        expect(await client.cmd('add', { by: 1 }));
        client.close();
    } finally {
        child.kill();
        await rm(socket, { force: true });
    }

    console.log('\n入门二 ✔ 同样的三个动词，这次对面是**另一个进程**');
}
