// 08 — 声明式：契约（api.ts）与实现（impl.ts）分居两文件，类型只推一次
//
//   node --import tsx pkgs.ts/core/actor/examples/08-cmd/
//
// 和 06 做同一个业务。两边都是「契约一个文件、实现一个文件」，差别在实现那侧：
//
//   06（手写桥）   server.ts 里每个方法手写一行转手 + 手写类型
//   08（cmd）      implement(roomApi, setup, handlers)，类型全部从 roomApi 推出
//
// 底下仍然是 rpc：mountService / createTypedClient / transport / 取消帧一个没少。
// 这里换掉的是样板，不是协议 —— 06 里讲过的断线、错误码、超时，这里同样适用。
//
// 关键：客户端那侧（下面 createActorClient 之前的部分）只 import 了 ./api.js。
// ./impl.js 只在服务端出现 —— 所以 impl 里 import 什么都不会进客户端包。

import { ChannelClientBinding, ChannelServerBinding, createMemTransportPair } from '@diy-agent/rpc';
import { actorOf, createActorClient, serveActor } from '../../src/cmd.js';
import { roomApi } from './api.js';
import { initCount, makeRoom } from './impl.js';

// ══ 本地：actorOf ═══════════════════════════════════════════════════

const room = actorOf(makeRoom);
console.log('本地 →', await room.say({ who: '你', text: '一' }));
console.log('本地 →', await room.say({ who: '你', text: '二' }));

// ══ 远端：三行装配 ══════════════════════════════════════════════════
//
// 客户端拿到的就是 roomApi 本身 —— 不需要再执行一次工厂去「取契约」。
// 换成真跨进程只要把 client 换成 06 的 ipcTransport(childChan(child))，其余不动。

const { serverTx, clientTx } = createMemTransportPair();
const server = new ChannelServerBinding(serverTx);
const client = new ChannelClientBinding(clientTx);

const remoteActor = actorOf(makeRoom);
serveActor(remoteActor, server, 'room');
const remote = createActorClient({ api: roomApi, client, prefix: 'room' });

// 类型是从 cmd 声明推出来的，不是 any 蒙的：
const seq: number = await remote.say({ who: '你', text: '三' });
console.log('远端 →', seq, `（类型 ${typeof seq}，没 cast）`);
// 远端 actor 是独立的一份状态（这正是 actor 的语义），所以它只记得自己收到的那条
console.log('远端 →', await remote.lines({}));

// ══ 取消：rpc 的 cancel 帧 → opts.signal → 内核的调用级 signal ═══════
//
// 06 里这里写的是 remote.$call('slow', [3000], { signal })；现在不用 $call。

const ctl = new AbortController();
setTimeout(() => ctl.abort(new Error('用户按了停止')), 100);
const t0 = Date.now();
try {
    await remote.slow({ ms: 3000 }, { signal: ctl.signal });
} catch (e) {
    console.log(`取消：${Date.now() - t0}ms 后抛错：${(e as Error).message}`);
}
// 同一个 actor 的本地引用：这次没人 abort，所以跑满 3 秒（证明慢方法真的在对面跑）
const t1 = Date.now();
console.log(`本地直连同一个 actor → ${await remoteActor.slow({ ms: 3000 })}（${Date.now() - t1}ms）`);

// 取消之后还能继续用
console.log('取消之后还能继续 →', await remote.lines({}));

// ══ 校验 + 错误跨进程 ═══════════════════════════════════════════════

try {
    await remote.say({ who: '', text: '空的' });
} catch (e) {
    console.log('入参被拦在方法之前 →', String(e).replace(/\s+/g, ' ').slice(0, 60));
}
try {
    await remote.boom({ msg: '炸了' });
} catch (e) {
    console.log('对面 throw →', (e as Error).message);
}

// ══ setup 只跑真正建了实例的地方 ═════════════════════════════════════
//
// 旧写法这里是 3 次（本地 actor、远端 actor、apiOf 各一次）—— 因为客户端要「执行
// 一次工厂去取契约」。现在契约是静态的，客户端不执行任何实现代码，所以是 2 次。

console.log(`\nsetup 跑了 ${initCount()} 次（本地 actor + 远端 actor，客户端 0 次）`);

await room.close();
await remoteActor.close();
