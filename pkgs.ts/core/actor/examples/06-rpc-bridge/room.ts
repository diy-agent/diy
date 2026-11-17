// room.ts — 业务本体。**这个文件里没有一个字跟「跨进程」有关。**
//
// 它和第 02 节那个 room 是同一类东西：私有状态 + 一张方法表。
// 下面 index.ts / server.ts 做的一切，都是给这张方法表套一层管子。

import { actor } from '../../src/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const makeRoom = () =>
    actor((life) => {
        const lines: { seq: number; who: string; text: string }[] = [];
        let seq = 0;
        let lastSlow = '(没跑过)';

        return {
            say(who: string, text: string) {
                if (!who) throw new Error('发言人不能为空'); // ← 04 节说过：抛错只影响这一次调用
                seq += 1;
                const line = { seq, who, text };
                lines.push(line);
                console.log(`  [子进程] ${seq}. ${who}: ${text}`);
                return line;
            },

            /** 一次慢活：每 10ms 看一次自己还在不在 */
            async slow(ms: number): Promise<string> {
                for (let i = 1; i <= ms / 10; i++) {
                    // ↓ 和 04 是同一行。它不知道自己是被本地 close() 取消的，
                    //   还是被另一个进程的 abort 取消的 —— 也不用知道。
                    if (life.signal.aborted) {
                        lastSlow = `第 ${i} 次检查时停下`;
                        console.log(`  [子进程] ${lastSlow}`);
                        return lastSlow;
                    }
                    await sleep(10);
                }
                lastSlow = '跑完了';
                return lastSlow;
            },

            log() {
                return lines;
            },
            lastSlow() {
                return lastSlow;
            },
        };
    });

export type Room = ReturnType<typeof makeRoom>;
