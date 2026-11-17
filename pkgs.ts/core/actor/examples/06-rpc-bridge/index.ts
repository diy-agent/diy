// 06 — 跨进程：actor + 一层 rpc 桥
//
//   node --import tsx pkgs.ts/core/actor/examples/06-rpc-bridge/
//
// 这一节只讲一件事：**actor 不负责跨网络，rpc 负责。**
//
//   业务本体（room.ts）    一字不改
//   契约（api.ts）         每个方法一行，两端共享
//   管子（ipc.ts）         10 行，换 ws / http / electron 只换这个文件
//   桥（server.ts）        每个方法一行 handler（把 args 拆回位置参数）
//   客户端（本文件）       createScopedClient，拿到的是一个普通对象
//
// 为什么不用「actor 自带的网络层」：那等于自造第四种 transport —— 和 rpc 的
// ws / http / electron 平行但不兼容，于是断线、超时、错误码、取消帧、CLI 入口
// 全都要重写一遍，而且写出来的更弱。桥接只用掉 rpc 已有的东西。

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ChannelClientBinding, createScopedClient } from '@diy-agent/rpc';
import { roomApi } from './api.js';
import { childChan, ipcTransport } from './ipc.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** api 的 output 是 z.unknown()，所以拿回来要 cast —— 见 api.ts 最后一段 */
interface Line {
    seq: number;
    who: string;
    text: string;
}

const serverPath = fileURLToPath(new URL('./server.ts', import.meta.url));
const child = fork(serverPath, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});

// ══ 客户端：和普通 rpc 客户端没有区别 ═══════════════════════════════════

const room = createScopedClient({
    api: roomApi,
    client: new ChannelClientBinding(ipcTransport(childChan(child))),
    prefix: 'room',
});

// ══ 一、两个进程，一张方法表 ═════════════════════════════════════════════
// 这里看起来就像在调本地对象。实际上 say() 的每一次都在子进程里跑。

console.log('\n══ 一、远端调用 ══');
await room.say({ args: ['你', '一'] });
await room.say({ args: ['你', '二'] });
await room.say({ args: ['你', '三'] });

// ══ 二、并发：串行语义跟着 actor 走，不跟着网络走 ═══════════════════════
// 三次并发发出去，seq 仍然是 3、4、5 —— 因为对面只有一个 actor 实例，
// 一条串行链。桥接不改语义：远端看到的和本地调用完全一样。

console.log('\n══ 二、并发三次（seq 应该连号） ══');
const burst = await Promise.all([
    room.say({ args: ['a', 'x'] }),
    room.say({ args: ['b', 'y'] }),
    room.say({ args: ['c', 'z'] }),
]);
console.log('  拿回 seq →', burst.map((r) => (r as Line).seq).join(', '));

// ══ 三、取消：abort 穿过进程边界 ═════════════════════════════════════════
// 这是最值得看的一段。客户端 abort 之后，**对面那个方法真的停了**，
// 停在它自己的 `if (life.signal.aborted)` 上 —— 和 04 的本地取消是同一行。

console.log('\n══ 三、远程取消 ══');
const ctl = new AbortController();
setTimeout(() => ctl.abort(new Error('用户按了停止')), 100);

const t0 = Date.now();
try {
    await room.slow({ args: [3000] }, { signal: ctl.signal }); // ← 本来要跑 3000ms
} catch (err) {
    console.log(`  客户端 ${Date.now() - t0}ms 后抛错：${(err as Error).message}`);
}

// 关键取证：客户端早就返回了，对面那个循环到底停没停？
await sleep(3400); // 如果对面没收到取消，这会儿它应该刚好「跑完了」
const lastSlow = await room.lastSlow({});
console.log(`  3.4s 后问对面：${lastSlow}`);
if (lastSlow === '跑完了') throw new Error('对面没收到取消 —— 客户端只是本地放弃了');
console.log('  ↑ 不是「客户端不等了」，是「对面停了」—— 取消帧真的过去了');

// 中断之后 actor 还活着，不用重建
const after = (await room.say({ args: ['你', '四'] })) as Line;
console.log(`  再调一次 → ${after.seq}. ${after.who}: ${after.text}`);

// ══ 四、错误：对面 throw，这边 reject ═══════════════════════════════════
// rpc 带错误码（这次是 INTERNAL），不是只有一句 message。

console.log('\n══ 四、错误跨进程 ══');
try {
    await room.say({ args: ['', '没人署名的发言'] }); // 对面抛：发言人不能为空
} catch (err) {
    const e = err as { message: string; code?: string };
    console.log(`  对面 throw → 这边 ${e.code ?? '?'}：${e.message}`);
}
console.log('  ↑ 带错误码，不是只有一句 message —— 调用方可以按 code 分支');

// ══ 收尾 ═════════════════════════════════════════════════════════════════
console.log('\n对面进程里的日志：');
for (const line of (await room.log({})) as Line[]) console.log(`  ${line.seq}. ${line.who}: ${line.text}`);

child.send({ t: 'bye' });
await new Promise<void>((resolve) => child.on('exit', () => resolve()));
console.log('\n子进程已退出（close() → abort + 排空，和 04 一样）');
