// 08 — 声明式：一条 cmd 同时是本地方法、契约、服务端 handler、强类型 client
//
//   node --import tsx pkgs.ts/core/actor/examples/08-cmd/
//
// 和 06 做同一个业务，区别只有一处：**契约不再是单独一个文件**。
//
//   06（手写桥）          api.ts 每个方法一行 + server.ts 每个方法一行转手
//   08（cmd）             cmd({ input, output }, run) 声明一次，四样东西自动出来
//
// 底下仍然是 rpc：mountService / createTypedClient / transport / 取消帧一个没少。
// 这里换掉的是样板，不是协议 —— 06 里讲过的断线、错误码、超时，这里同样适用。

import { ChannelClientBinding, ChannelServerBinding, createMemTransportPair } from '@diy-agent/rpc';
import { z } from 'zod';
import { actorOf, apiOf, cmd, createActorClient, serveActor } from '../../src/cmd.js';
import type { Life } from '../../src/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ══ 唯一真源：一份声明 ═══════════════════════════════════════════════
//
// 注意 keep()：它说明 factory 的闭包初始化会被跑两次（本地一次，apiOf 取契约又一次）。
// 所以 factory 必须无副作用 —— 和 rpc 的 api.ts 是同一条纪律。

let inits = 0;

const makeRoom = (life: Life) => {
    inits++;
    let seq = 0;
    const lines: string[] = [];

    return {
        // 入参 shape 顺带起到校验作用：who 传空串会被 rpc 拦在进方法之前
        say: cmd({ input: { who: z.string().min(1), text: z.string() }, output: z.number() }, ({ who, text }) => {
            seq++;
            lines.push(`${seq}. ${who}: ${text}`);
            return seq;
        }),

        // 出参 schema 只推类型，没有运行时开销，所以写精确的 shape
        lines: cmd({ input: {}, output: z.array(z.object({ seq: z.number(), text: z.string() })) }, () =>
            lines.map((text, i) => ({ seq: i + 1, text })),
        ),

        // 要感知取消就读闭包里的 life.signal —— 和 04 是同一行
        slow: cmd({ input: { ms: z.number() }, output: z.string() }, async ({ ms }) => {
            for (let i = 1; i <= ms / 10; i++) {
                if (life.signal.aborted) return `第 ${i} 次检查时停下`;
                await sleep(10);
            }
            return '跑完了';
        }),

        boom: cmd({ input: { msg: z.string() }, output: z.void() }, ({ msg }) => {
            throw new Error(msg);
        }),
    };
};

// ══ 本地：actorOf ═══════════════════════════════════════════════════

const room = actorOf(makeRoom);
console.log('本地 →', await room.say({ who: '你', text: '一' }));
console.log('本地 →', await room.say({ who: '你', text: '二' }));

// ══ 远端：三行装配 ══════════════════════════════════════════════════
//
// apiOf(makeRoom) 只取 cmd 定义，丢掉状态 —— 客户端不需要 actor 实例，也就没有链。
// 换成真跨进程只要把 client 换成 06 的 ipcTransport(childChan(child))，其余不动。

const { serverTx, clientTx } = createMemTransportPair();
const server = new ChannelServerBinding(serverTx);
const client = new ChannelClientBinding(clientTx);

const remoteActor = actorOf(makeRoom);
serveActor(remoteActor, server, 'room');
const remote = createActorClient({ api: apiOf(makeRoom), client, prefix: 'room' });

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

// ══ factory 跑了两次 ════════════════════════════════════════════════

console.log(`\nfactory 被调用 ${inits} 次（本地 1 + 远端 actor 1 + apiOf 1）—— 所以必须无副作用`);

await room.close();
await remoteActor.close();
