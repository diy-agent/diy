// hello-inproc.ts — 入门一：一个 actor + 一个调用方，**同一个进程，没有网络**。
//
//   ./sha.sh hello      （等价于 node --import tsx examples/hello-inproc.ts）
//
// 这份只讲三件事：怎么接线、方法怎么调、结果长什么样。
// kind 的声明在 hello-counter.ts；接上真网络见 hello-net.ts（调用那几行不用改）。

import { createLocalActor, useKind } from '../src/index.js';

import { counter } from './hello-counter.js';

// ── 接线：一个 actor（带内存 store）+ 一条内存链路 + 一个 client ──────────────
// 换成 socket 就是 hello-net.ts 里的 serveActor / connectActor，下面几行不用改。
const { client, actor } = await createLocalActor({ kind: counter, uri: 'hello://counter' });

// ── 契约 → 一组有类型的方法 ────────────────────────────────────────────────
// `hello.add` / `hello.get` 就是 kind 里声明的那两个：名字、入参、出参全从 schema 推出来。
// 拼错名字、少传字段、把结果当别的形状用 —— 都是**编译期**红，不是跑到线上才发现。
const hello = useKind(counter, client);

// ── 事件：先订阅，再动 ────────────────────────────────────────────────────
// `$on` 只收订阅之后的（要连历史一起收是 `$watch`）。handler 的载荷也有类型。
const off = hello.$on('added', (event) => console.log('event →', event));

// ── 写与读：调用即得值 ────────────────────────────────────────────────────
// 没有 `{ ok, data }` 要拆：失败会抛 `ActorError`（带 code / retryable）。
console.log('add   →', await hello.add({ by: 2 })); // { n: 2 }
console.log('get   →', await hello.get({})); // { n: 2 }

off();

// ── 这一层之下是什么 ──────────────────────────────────────────────────────
// 三个动词 + `Outcome` 判别联合就是 raw 层；UI 用函数层，网关/转发用 raw 层。
// 同一个 client，所以两层可以混着用，不用重新接线。
console.log('raw   →', await client.cmd('add', { by: 1 }));

await actor.close();
console.log('\n入门一 ✔ 调用即得值（同一个进程，没有网络）');
