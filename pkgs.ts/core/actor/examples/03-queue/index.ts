// 03 — 连点三次：排队，但不阻塞 UI
//
//   node --import tsx pkgs.ts/core/actor/examples/03-queue/
//
// 这一节只讲一件事：**用户连点 N 次 = N 个工作单元，按点击顺序跑，一次一个**。
// UI 不需要禁用按钮，也不需要自己写队列。

import { actor } from '../../src/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 假装是一次 LLM 调用：慢，且回复内容取决于「发出请求时看到了几条历史」 */
async function runTurn(seen: number): Promise<string> {
    await sleep(40);
    return `回复（发出时看到 ${seen} 条历史）`;
}

// ══ 一、不排队：后一次看不到前一次的结果 ════════════════════════════════

const unsafeLog: string[] = [];

async function unsafeSay(text: string): Promise<string> {
    const seen = unsafeLog.length; // ← 读历史
    await sleep(40); // ← 这里另外两次也读了同一份历史
    const reply = await runTurn(seen);
    unsafeLog.push(`你: ${text}`, `agent: ${reply}`);
    return reply;
}

await Promise.all([unsafeSay('一'), unsafeSay('二'), unsafeSay('三')]);
console.log('不排队的三次：');
for (const l of unsafeLog) console.log(`  ${l}`);
console.log('  ↑ 三个 turn 都以为自己看到 0 条历史 —— 前面两次的回复它们都没看见\n');

// ══ 二、用 actor：同一个接口，顺序自己就对了 ════════════════════════════

const room = actor(() => {
    const history: string[] = [];

    return {
        /** 一次「用户说话 + agent 回复」= 一个工作单元 */
        async say(text: string): Promise<{ seq: number; reply: string }> {
            history.push(`你: ${text}`);

            // 这一行一定看得见前面所有 turn 的结果 —— 因为它们在链上排在前面
            const reply = await runTurn(history.length);
            history.push(`agent: ${reply}`);

            return { seq: history.length / 2, reply };
        },

        transcript(): readonly string[] {
            return [...history];
        },
    };
});

// 模拟用户狂点三次：三个调用并发发出，一个 await 都没加
const clicked = await Promise.all([room.say('一'), room.say('二'), room.say('三')]);

console.log('排队后的三次：');
for (const { seq, reply } of clicked) console.log(`  #${seq} → ${reply}`);

console.log('\n最终 transcript：');
for (const l of await room.transcript()) console.log(`  ${l}`);

// ══ 三、长时间的任务不会阻塞「读」以外的东西 ════════════════════════════
// 同一个 room 里，读也排队 —— 所以读到的永远是「某个工作单元跑完」的状态，
// 不会读到写了一半的中间态。

const t0 = Date.now();
const pending = room.say('四'); // 慢
const snapshot = room.transcript(); // 排在「四」后面
console.log(`\n读到的条数：${(await snapshot).length}（含刚说完的「四」，不含它一半的状态）`);
await pending;
console.log(`总耗时 ${Date.now() - t0}ms`);
