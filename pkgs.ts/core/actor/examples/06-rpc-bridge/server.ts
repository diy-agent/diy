// server.ts — 子进程入口：一个普通 actor + 一层 rpc 桥
//
// 注意这里**没有一行网络代码**。`makeRoom()` 和 02 节那个是同一个东西，
// 它不知道自己在子进程里，也不知道有人在另一边调它。
//
// 三块各管一件事：
//   api.ts     有哪些方法（两端共享的契约）
//   room.ts    方法怎么实现（业务本体，与跨进程无关）
//   本文件      方法表 → api：一行一个转手

import { ChannelServerBinding, mountService } from '@diy-agent/rpc';
import { roomApi } from './api.js';
import { ipcTransport, processChan } from './ipc.js';
import { makeRoom } from './room.js';

const server = new ChannelServerBinding(ipcTransport(processChan()));
const room = makeRoom();

mountService(server, {
    prefix: 'room',
    api: roomApi,
    handlers: {
        say: ({ input }) => room.say(input.args[0] as string, input.args[1] as string),

        // ↓ 唯一要写的「转手」：rpc 的 signal → actor 的调用级 signal。
        //   这一行让「对面点了取消」变成「方法内部 life.signal.aborted」。
        //   用 $call 而不用 room.slow(...)，只是因为要把 signal 递进去。
        slow: ({ input, signal }) => room.$call('slow', [input.args[0] as number], { signal }),

        log: () => room.log(),
        lastSlow: () => room.lastSlow(),
    },
});

// 客户端说再见 → 正常关掉 actor（04 那套：abort + 排空），然后退出
process.on('message', (msg) => {
    if ((msg as { t?: string }).t === 'bye') {
        void room.close().then(() => process.exit(0));
    }
});
