// 02 — 调用方看到的是普通函数，不是消息对象
//
//   node --import tsx pkgs.ts/core/actor/examples/02-room/
//
// 这一节只讲一件事：**`await room.say(...)` 拿到的是这一次调用的结果**，
// 有类型、有返回值、不需要订阅、不需要自己维护 id → promise 的表。

import { actor } from '../../src/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Line {
    seq: number;
    who: string;
    text: string;
    at: number;
}

const room = actor(() => {
    const lines: Line[] = [];
    let seq = 0;

    // ↓ 内部函数：**不排队**。它已经在这条链上了，再排一次就是自己等自己。
    //   这是唯一要小心的事：actor 内部互调，走内部函数，不走 api。
    const push = (who: string, text: string): Line => {
        const line: Line = { seq: ++seq, who, text, at: Date.now() };
        lines.push(line);
        return line;
    };

    return {
        /** 人说话：模拟一次网络/落盘，所以它必须是 async */
        async say(who: string, text: string): Promise<Line> {
            await sleep(20);
            return push(who, text);
        },

        /** bot 回复：内部调 push，所以不会被 say 的队列挡住 */
        async reply(text: string): Promise<Line> {
            await sleep(60); // LLM 比较慢
            return push('agent', text);
        },

        /** 读：**也排队**。所以读一定看得见更早投递的全部写 */
        log(): readonly Line[] {
            return [...lines];
        },

        last(): Line | undefined {
            return lines.at(-1);
        },
    };
});

// ── 调用方：就是普通函数调用 ────────────────────────────────────────────

const [mine, answer, next] = await Promise.all([
    room.say('你', '你好'),
    room.reply('你好，我是 agent'),
    room.say('你', '下一题'),
]);

console.log('三个调用同时发出，每个都拿回自己那一条：');
for (const line of [mine, answer, next]) {
    console.log(`  seq=${line.seq}  ${line.who}: ${line.text}`);
}

console.log('\n日志里的顺序（由投递顺序决定，与完成先后无关）：');
for (const line of await room.log()) {
    console.log(`  ${line.seq}. ${line.who}: ${line.text}`);
}

// ── 类型是白拿的 ────────────────────────────────────────────────────────
// 下面这个函数不会执行，只用来证明编译器认得这些方法。

export function _typeCheck(): void {
    // @ts-expect-error 少传一个参数
    void room.say('你');
    // @ts-expect-error log() 返回 Line[]，没有 seq
    void room.log().seq;
    // @ts-expect-error 没有这个方法
    void room.shout('x');
}

// ── 和「消息式」的差别 ──────────────────────────────────────────────────
// 消息式的调用方是这样：
//
//     room.send({ type: 'say', who, text });
//     const off = room.on('said', ({ seq, id }) => { if (id === myId) resolve(seq) });
//
// 调用方要多做三件事：自己生成 id、维护 id → resolve 的表、记得取消订阅。
// 这里一件都不用做 —— 方法的返回值本来就是回执。
