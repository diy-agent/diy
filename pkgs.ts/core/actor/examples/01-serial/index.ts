// 01 — 为什么需要 actor：一个 lost update 就够了
//
//   node --import tsx pkgs.ts/core/actor/examples/01-serial/
//
// 这一节只讲一件事：**不排队会丢东西**。别的都别记。

import { actor } from '../../src/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ══ 一、不排队 ══════════════════════════════════════════════════════════
// 读 → await → 写。真实代码里 await 的位置是 fetch / 文件 / LLM。

let counter = 0;

async function unsafeInc(): Promise<void> {
    const value = counter;
    await sleep(10); // ← 这 10ms 里，另外两个调用也读到了同一个 value
    counter = value + 1;
}

await Promise.all([unsafeInc(), unsafeInc(), unsafeInc()]);
console.log(`不用 actor，连点三次 → ${counter}（应该是 3）`);

// ══ 二、用 actor ════════════════════════════════════════════════════════

const safe = actor(() => {
    let n = 0;

    return {
        async inc(): Promise<number> {
            const value = n;
            await sleep(10); // 中间照样可以 await，这期间没人能插进来
            n = value + 1;
            return n;
        },
        get(): number {
            return n;
        },
    };
});

// 三个调用同时发出，一个 await 都不加 —— 顺序由 actor 保证
const results = await Promise.all([safe.inc(), safe.inc(), safe.inc()]);
console.log(`用 actor，连点三次 → ${results.join(', ')}（每个调用拿到自己那一次的结果）`);
console.log(`最后读一次 → ${await safe.get()}`);

// ══ 三、粒度是「一个 actor」，不是一个进程 ══════════════════════════════

const slow = actor(() => ({
    async ping(): Promise<string> {
        await sleep(50);
        return 'slow';
    },
}));

const fast = actor(() => ({
    async ping(): Promise<string> {
        await sleep(50);
        return 'fast';
    },
}));

const t0 = Date.now();
const both = await Promise.all([slow.ping(), fast.ping()]);
console.log(`两个 actor 同时跑 → ${both.join(' + ')}，耗时 ${Date.now() - t0}ms（≈50，不是 100）`);

// ══ 四、一条命令失败，不该卡死后面全部 ══════════════════════════════════

const flaky = actor(() => ({
    fail(): never {
        throw new Error('boom');
    },
    ok(): string {
        return 'still alive';
    },
}));

await flaky.fail().catch((e: Error) => console.log(`第一条炸了 → ${e.message}`));
console.log(`第二条照跑 → ${await flaky.ok()}`);
