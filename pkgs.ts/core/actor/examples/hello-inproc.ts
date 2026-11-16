// hello-inproc.ts — 入门一：一个 actor + 一个调用方，**同一个进程，没有网络**。
//
//   ./sha.sh hello      （等价于 node --import tsx examples/hello-inproc.ts）
//
// 这份只讲三件事：怎么接线、三个动词怎么用、结果长什么样。
// kind 的声明在 hello-counter.ts；接上真网络见 hello-net.ts。

import { createLocalActor, expect } from '../src/index.js';

import { counter } from './hello-counter.js';

// ── 接线：一个 actor（带内存 store）+ 一条内存链路 + 一个 client ──────────────
// 换成 socket 就是 hello-net.ts 里的 serveActor / connectActor，这 20 行不用改。
const { client, actor } = await createLocalActor({ kind: counter, uri: 'hello://counter' });

// ── 动词一：cmd（写）─────────────────────────────────────────────────────
// 所有写操作在 actor 里**排成一条队列**，一次跑一个 —— 这就是「单写者」。
const written = await client.cmd('add', { by: 2 });
console.log('cmd   →', written); // ok:true 时带 seq（这次提交在事件流里的位置）

// ── 动词二：query（读）───────────────────────────────────────────────────
// 原样是 { ok, data, watermark, stale, meta }：watermark = 读到哪个位置，stale = 是不是旧的；
// meta 只有扇出查询才有值，这里用 JSON 打一行，免得 inspect 把 undefined 也画出来。
console.log('query →', JSON.stringify(await client.query('get', {})));

// ── 动词三：watch（事件流）───────────────────────────────────────────────
// 先补历史、再追实时。是 async generator，不是回调。
for await (const event of client.watch({ include: ['added'] })) {
    console.log('watch →', event.name, event.data, 'seq =', event.seq);
    break; // 读到第一条就退（generator 没有外部取消，不 break 会一直等下去）
}

// `expect` 只做一件事：把 `ok:false` 变成抛出。不想写一堆 `if (!outcome.ok)` 时才用。
// （协议本身不抛异常：失败是一个**返回值**，调用方自己决定要不要当错误处理。）
expect(await client.cmd('add', { by: 1 }));

await actor.close();
console.log('\n入门一 ✔ 写、读、事件流都走通了（同一个进程，没有网络）');
