#!/usr/bin/env node
// scripts/warm-wait-stats.mjs — 冷缓存等待（##486）的**效果统计**：判据 4 的算法落地。
//
// 用户要观察的是「等待组的再全冷率是否比 3.5% 基线下降」，所以这里只算两件事：
//   ① 等待组 = 账上有 `waitedMs` 的步：它自己还是不是全冷？
//   ② 对照组 = 上一步全冷、但**没等**的步（开关关掉 / 小请求 / 本刀上线前的历史）：
//      同一个条件概率有多高？—— 这就是 3.5% 的口径，现算一遍好对比。
// 再附带一行总览（相邻两步的零缓存率），用来对照 body 里的 0.8% 基线。
//
// 口径与「上一步全冷」判据同源（`shared/warm-wait.ts`）：
//   全冷 = cacheRead / inputTokens < 0.05 且 inputTokens > 0
// 相邻 = 同一任务账本里的相邻两行（一行 = 一个请求步）。
//
// 用法：
//   node scripts/warm-wait-stats.mjs                  # 扫 $DIY_HOME 下全部 *.usage.jsonl
//   node scripts/warm-wait-stats.mjs <a.jsonl> [...]  # 只算指定账本
//   DIY_HOME=/tmp/x node scripts/warm-wait-stats.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COLD_RATIO_MAX = 0.05;

/** 递归找 `*.usage.jsonl`（跳过 node_modules / .git） */
function findLedgers(dir, out = []) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) findLedgers(p, out);
        else if (e.name.endsWith('.usage.jsonl')) out.push(p);
    }
    return out;
}

const inputOf = (row) => row?.usage?.inputTokens ?? 0;
const cacheReadOf = (row) => row?.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
/** 全冷：占比 < 0.05（与 shared/warm-wait.ts 同口径；input 为 0 的步算「不可判」→ null） */
const coldness = (row) => {
    const input = inputOf(row);
    if (input <= 0) return null;
    return cacheReadOf(row) / input < COLD_RATIO_MAX;
};

const args = process.argv.slice(2);
const files = args.length ? args : findLedgers(process.env.DIY_HOME || join(homedir(), '.diy'));

const waited = { n: 0, cold: 0 };
const control = { n: 0, cold: 0 };
const all = { n: 0, cold: 0 };
const rank = (input) => (input > 50_000 ? 'big' : 'small');
const empty = () => ({ n: 0, cold: 0 });
const bySize = { 'waited:big': empty(), 'waited:small': empty(), 'control:big': empty(), 'control:small': empty() };

let ledgers = 0;
let rows = 0;
for (const file of files) {
    let lines;
    try {
        lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
        continue;
    }
    ledgers++;
    const recs = [];
    for (const line of lines) {
        try {
            recs.push(JSON.parse(line));
        } catch {
            /* 坏行跳过 */
        }
    }
    rows += recs.length;
    for (let i = 0; i < recs.length; i++) {
        const cur = recs[i];
        const prev = i > 0 ? recs[i - 1] : null;
        const cold = coldness(cur);
        if (cold === null) continue;
        if (prev) {
            all.n++;
            if (cold) all.cold++;
        }
        const prevCold = prev ? coldness(prev) : null;
        if (prevCold !== true) continue;
        // prev 全冷 ⇒ cur 是「再全冷」的观察对象
        const bucket = cur.waitedMs != null ? waited : control;
        bucket.n++;
        if (cold) bucket.cold++;
        const sizeKey = `${bucket === waited ? 'waited' : 'control'}:${rank(inputOf(cur))}`;
        bySize[sizeKey].n++;
        if (cold) bySize[sizeKey].cold++;
    }
}

const pct = (b) => (b.n === 0 ? '—' : `${((b.cold / b.n) * 100).toFixed(1)}%（${b.cold}/${b.n}）`);

console.log(`账本 ${ledgers} 份 · ${rows} 步（口径：cacheRead/input < ${COLD_RATIO_MAX} 且 input > 0 = 全冷）`);
console.log('');
console.log('上一步全冷之后，这一步还是不是全冷：');
console.log(`  等待组（有 waitedMs）    ${pct(waited)}`);
console.log(`  对照组（没等，历史/开关/小请求） ${pct(control)}`);
console.log(`    其中大请求  等待 ${pct(bySize['waited:big'])} · 对照 ${pct(bySize['control:big'])}`);
console.log('');
console.log(`相邻两步总览（不分是否等待）  ${pct(all)}   ← 对照基线：全冷后 3.5% / 正常后 0.8%`);
