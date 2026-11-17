// 05 — 崩溃恢复：一次提交 = 一行
//
//   node --import tsx pkgs.ts/core/actor/examples/05-persist/
//
// 这一节只讲一件事：**状态和游标写在同一次 append 里**，
// 所以「崩在中间」只有两种可能：那一行没有，或那一行完整。
// 不存在「状态写了、游标没写」这种半截。

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { actor } from '../../src/index.js';

interface Line {
    seq: number;
    who: string;
    text: string;
}

interface State {
    lines: Line[];
    seq: number;
}

const dir = await mkdtemp(path.join(tmpdir(), 'actor-lite-'));
const store = path.join(dir, 'room.jsonl');
console.log(`存储文件：${store}\n`);

/** 恢复：读最后一行 —— 它本身就是完整状态 */
async function load(): Promise<State> {
    const raw = await readFile(store, 'utf8').catch(() => '');
    const last = raw.trim().split('\n').filter(Boolean).at(-1);
    return last ? (JSON.parse(last) as State) : { lines: [], seq: 0 };
}

/** 起一个 room：状态从上一个进程的最后一版开始 */
async function openRoom() {
    const state = await load();
    console.log(`  （启动时恢复：seq=${state.seq}，${state.lines.length} 条消息）`);

    return actor(() => ({
        async say(who: string, text: string): Promise<Line> {
            const line: Line = { seq: ++state.seq, who, text };
            state.lines.push(line);

            // ↓ 一次 append：状态 + 游标在同一行里
            await appendFile(store, JSON.stringify(state) + '\n');
            return line;
        },

        log(): readonly Line[] {
            return [...state.lines];
        },

        /** 只在范例里用：改内存、不落盘 —— 模拟「改完还没 append 就被 kill -9」 */
        _pushWithoutSave(line: Line): void {
            state.lines.push(line);
        },
    }));
}

// ══ 一、正常跑三次 ═══════════════════════════════════════════════════════

const first = await openRoom();
for (const text of ['一', '二']) await first.say('你', text);
await first.close(); // 进程退出

// ══ 二、重启：seq 接着走，没有重号 ═════════════════════════════════════

const second = await openRoom();
const line = await second.say('你', '三');
console.log(`重启后第一条 → seq=${line.seq}（不是 1）`);
console.log(`恢复出来的日志：${(await second.log()).map((l) => `${l.seq}.${l.text}`).join(' ')}\n`);

// ══ 三、崩在中间 ═══════════════════════════════════════════════════════
// 模拟：改完内存、还没来得及 append 就被 kill -9。
// 那一行不存在 → 状态自然回到上一版，不会「消息有了但序号没走」。

const crash = await openRoom();
// 内存里改了一半的现场：只 push，没 append
await crash._pushWithoutSave({ seq: 999, who: '你', text: '这条会丢' });
await crash.close();

const after = await openRoom();
console.log(`崩溃后重启看到的条数：${(await after.log()).length}（那条没落盘的凭空消失）`);
console.log(`日志：${(await after.log()).map((l) => `${l.seq}.${l.text}`).join(' ')}`);

console.log('\n文件里最后两行（一行一次提交，没有半截状态）：');
const lines = (await readFile(store, 'utf8')).trim().split('\n');
for (const l of lines.slice(-2)) console.log(`  ${l}`);

await after.close();
await rm(dir, { recursive: true, force: true });
