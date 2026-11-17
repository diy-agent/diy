// 06 — 跨进程：调用方那几行一个字都不用改
//
//   node --import tsx pkgs.ts/core/actor/examples/06-net/
//
// 这一节只讲一件事：**方法调用本来就是消息**。
// 换进程只改「帧怎么送」，不改「代码怎么写」。
//
//   本地：  run = () => fn.apply(impl, args)
//   远程：  run = () => 把 { id, method, args } 发出去，等 { id, ok, data }

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { actor } from '../../src/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const self = fileURLToPath(import.meta.url);

// ══════════════════════════════════════════════════════════════════════════
// 服务端（另一个进程）
// ══════════════════════════════════════════════════════════════════════════

if (process.env.ROLE === 'server') {
    // 跟例子 02 完全是同一个 actor，一行不用改
    const room = actor(() => {
        const lines: { seq: number; who: string; text: string }[] = [];
        let seq = 0;

        const push = (who: string, text: string) => {
            const line = { seq: ++seq, who, text };
            lines.push(line);
            return line;
        };

        return {
            async say(who: string, text: string) {
                await sleep(20);
                return push(who, text);
            },
            log() {
                return [...lines];
            },
        };
    });

    // ↓ 整个「跨进程适配器」就这三行
    process.on('message', async (frame: any) => {
        try {
            const data = await (room as any)[frame.method](...frame.args);
            process.send!({ id: frame.id, ok: true, data });
        } catch (err) {
            process.send!({ id: frame.id, ok: false, error: (err as Error).message });
        }
    });
} else {
    // ══════════════════════════════════════════════════════════════════════
    // 客户端（本进程）
    // ══════════════════════════════════════════════════════════════════════

    const child = fork(self, { execArgv: ['--import', 'tsx'], env: { ROLE: 'server' }, stdio: 'inherit' });

    // ↓ 帧协议的全部内容：id + method + args / ok + data
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let nextId = 0;

    child.on('message', (frame: any) => {
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.data);
        else waiter.reject(new Error(frame.error));
    });

    function call<T>(method: string, ...args: unknown[]): Promise<T> {
        const id = ++nextId;
        return new Promise<T>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.send({ id, method, args });
        });
    }

    // ↓ 这一层就是「远程的 actor」。类型手写一次，别的地方不再管传输。
    const room = {
        say: (who: string, text: string) => call<{ seq: number; who: string; text: string }>('say', who, text),
        log: () => call<{ seq: number; who: string; text: string }[]>('log'),
    };

    // ── 以下跟例子 02 的调用方一模一样 ────────────────────────────────

    const [a, b, c] = await Promise.all([
        room.say('你', '一'),
        room.say('你', '二'),
        room.say('你', '三'),
    ]);

    console.log('跨进程调用，每个调用拿回自己那一条：');
    for (const line of [a, b, c]) console.log(`  seq=${line.seq}  ${line.who}: ${line.text}`);

    console.log('\n对面进程里的日志：');
    for (const line of await room.log()) console.log(`  ${line.seq}. ${line.who}: ${line.text}`);

    child.kill();

    // 代价只有一条：args / 返回值必须可序列化（不能传函数、class 实例、循环引用）。
}
