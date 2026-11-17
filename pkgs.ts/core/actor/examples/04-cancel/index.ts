// 04 — 取消：中断正在跑的，保留已经产出的
//
//   node --import tsx pkgs.ts/core/actor/examples/04-cancel/
//
// 这一节讲三件事：
//   1. `close()` 会 abort，正在跑的工作单元自己决定「在哪停」
//   2. 停下来的那个调用**正常返回**它已经产出的部分，不是抛异常
//   3. 读也排队 —— 所以「看中间态」不能靠回头查，只能靠推

import { actor } from '../../src/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const room = actor((life) => {
    const chunks: string[] = [];

    return {
        /** 一次流式回复：每 10ms 产一个字 */
        async stream(_prompt: string): Promise<{ text: string; cancelled: boolean }> {
            chunks.length = 0;

            for (let i = 0; i < 100; i++) {
                // ↓ 唯一要自己写的一行：在「下一个 chunk 之前」看自己还在不在
                if (life.signal.aborted) {
                    return { text: chunks.join(''), cancelled: true };
                }

                await sleep(10);
                chunks.push('字');

                // 要看中间态，只能在这里推出去 —— 不能回头调 room.text()（它会排队）
                if (chunks.length === 12) console.log(`  （跑到第 ${chunks.length} 个 chunk 时按了取消）`);
            }

            return { text: chunks.join(''), cancelled: false };
        },
    };
});

// ══ 一、跑到一半按取消 ═══════════════════════════════════════════════════

const running = room.stream('写一篇很长很长的文章');
await sleep(120);
await room.close(); // ← abort + 排空

const result = await running; // 注意：它 resolve 了，不是 reject
console.log(`stream() 的返回值 → { ${result.text.length} 字, cancelled: ${result.cancelled} }`);
console.log('↑ 已经收到的部分还在，调用方拿得到，不需要重启或另外查库\n');

// ══ 二、关掉之后，新调用被拒（而不是悄悄排队） ══════════════════════════

try {
    await room.stream('再来一次');
} catch (err) {
    console.log(`关掉之后再调用 → ${(err as Error).message}`);
}
console.log(`room.closed = ${room.closed}`);

// ══ 三、不检查 signal 会怎样 ═════════════════════════════════════════════
// close() 会一直等到那个工作单元跑完。所以「能取消」不是框架送的，
// 是任务自己在边界上让出来的 —— 一行 if。

const stubborn = actor(() => ({
    async slow(): Promise<string> {
        await sleep(200); // 不看 signal
        return '我还是跑完了';
    },
}));

const t0 = Date.now();
const job = stubborn.slow();
await sleep(10);
await stubborn.close();
console.log(`\n不检查 signal 的 actor：close() 等了 ${Date.now() - t0}ms，结果 = ${await job}`);
console.log('↑ 该停的时候没停 —— 这一行 if 没人能替你写');
