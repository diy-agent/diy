// scenario.ts — 剧本：**真进程**跑一遍 actor 协议的九条主张。
//
//   node --import tsx examples/demo/scenario.ts
//
// 为什么要有它：同进程的用例（tests/）证明不了传输与崩溃这两件事 ——
// 微任务链路里「掉线」只能是造出来的，重启只能是假的。这里每一条都是真的：
// 三个进程、unix socket、kill -9、同一个数据目录重启。
//
// 剧本里标「已知空洞」的地方是**真的空洞**（docs/08-roadmap.md 刀7），不粉饰。

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

import { newCommandId, type CmdOutcome, type QueryOutcome } from '../../src/index.js';
import { connectActor, unixTarget, waitForSocket } from '../lib/serve.js';
import { peerKind, roomKind } from './kinds.js';

// ── 剧本基础设施 ────────────────────────────────────────────────────────────

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '../../../../..');
/** socket 路径有长度上限（~104 字节），用短目录；macOS 的 /var/folders 前缀太长 */
const root = `/tmp/diy-actor-demo-${process.pid}`;
const sock = (name: string) => path.join(root, `${name}.sock`);
const dataDir = (name: string) => path.join(root, 'data', name);

function say(line: string): void {
    console.log(line);
}

function check(label: string, ok: boolean, detail: string): void {
    if (!ok) throw new Error(`${label} 不成立：${detail}`);
    say(`   ✔ ${detail}`);
}

const children: ChildProcess[] = [];

function startNode(script: string, env: Record<string, string>, name: string): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, script)], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    // 节点不该往 stdout 写（stdout 是帧的地盘）；日志一律 stderr，这里只转给诊断用
    child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(`[${name}!stdout] ${chunk.toString()}`));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${name}] ${chunk.toString()}`));
    return child;
}

function waitExit(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        child.once('exit', () => resolve());
    });
}

function doneOf<T>(outcome: CmdOutcome<T>): { data: T; seq: string } {
    if (!outcome.ok) throw new Error(`命令失败：${outcome.code} ${outcome.message}`);
    if (outcome.accepted) throw new Error('这条命令本应同步回 done，却回了 accepted');
    return { data: outcome.data, seq: outcome.seq };
}

function dataOf<T>(outcome: QueryOutcome<T>): T {
    if (!outcome.ok) throw new Error(`查询失败：${outcome.code} ${outcome.message}`);
    return outcome.data;
}

const rosterLine = (members: { memberId: string; state: string; reason?: string }[]): string =>
    members.map((m) => `${m.memberId}=${m.state}${m.reason ? `(${m.reason})` : ''}`).join(' ');

// ── 剧本 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    rmSync(root, { recursive: true, force: true });

    const peerSockets = { 'peer-a': sock('peer-a'), 'peer-b': sock('peer-b') };
    const roomSocket = sock('room');

    say('① 起 3 个进程：两个成员节点 + 一个房间节点（互相不认识，只靠 socket 找得到）');
    startNode(
        'peer-node.ts',
        {
            DIY_DEMO_PEER_SOCKET: peerSockets['peer-a']!,
            DIY_DEMO_PEER_URI: 'diy://demo/peer-a',
            DIY_DEMO_PEER_DATA: dataDir('peer-a'),
        },
        'peer-a',
    );
    const peerB = startNode(
        'peer-node.ts',
        {
            DIY_DEMO_PEER_SOCKET: peerSockets['peer-b']!,
            DIY_DEMO_PEER_URI: 'diy://demo/peer-b',
            DIY_DEMO_PEER_DATA: dataDir('peer-b'),
        },
        'peer-b',
    );
    let room = startNode(
        'room-node.ts',
        {
            DIY_DEMO_ROOM_SOCKET: roomSocket,
            DIY_DEMO_ROOM_URI: 'diy://demo/room',
            DIY_DEMO_ROOM_DATA: dataDir('room'),
        },
        'room',
    );

    await Promise.all([
        waitForSocket(peerSockets['peer-a']!),
        waitForSocket(peerSockets['peer-b']!),
        waitForSocket(roomSocket),
    ]);
    check('起进程', true, `${root}（socket + 数据目录都在这里）`);

    // ② 客户端连房间：join ×2 + post
    say('② 客户端连房间，登记两个成员，然后发一条消息');
    let client = await connectActor({ kind: roomKind, socket: roomSocket });
    doneOf(await client.cmd('join', { memberId: 'peer-a', target: unixTarget(peerSockets['peer-a']!) }));
    doneOf(await client.cmd('join', { memberId: 'peer-b', target: unixTarget(peerSockets['peer-b']!) }));

    // 让 peer-a 处于「在跑」：直接连成员节点，用同一个 kind 的另一个客户端
    const peerClient = await connectActor({ kind: peerKind, socket: peerSockets['peer-a']! });
    doneOf(await peerClient.cmd('set', { label: 'peer-a', running: true }));
    peerClient.close();

    const postId = newCommandId();
    const posted = doneOf(await client.cmd('post', { text: '大家好' }, { commandId: postId }));
    check('post', posted.data.n === 1, `post → n=${posted.data.n} seq=${posted.seq}`);

    // ③ 读
    say('③ 读回来');
    const read1 = dataOf(await client.query('read', {}));
    check('read', read1.messages.length === 1, `read → messages=${read1.messages.length}`);

    // ④ 幂等：同一个 commandId 重发（网络抖一下）—— 位置也不能动
    say('④ 网络抖了一下：同一个 commandId 再发一次');
    const again = doneOf(await client.cmd('post', { text: '大家好' }, { commandId: postId }));
    const read2 = dataOf(await client.query('read', {}));
    check(
        '幂等',
        read2.messages.length === 1 && again.seq === posted.seq,
        `重发 → messages=${read2.messages.length} seq 相同=${again.seq === posted.seq}`,
    );

    // ⑤ 扇出：两个成员在**两个进程**里，一次查询问到两边
    say('⑤ 名册：一次查询扇出到两个进程');
    const roster1 = dataOf(await client.query('roster', {}));
    check(
        'roster',
        roster1.members.map((m) => m.state).join(',') === 'running,idle',
        `roster → ${rosterLine(roster1.members)}`,
    );

    // ⑥ 掉线：kill -9 一个成员节点，它必须还在名册里（是 unknown，不是消失）
    say('⑥ kill -9 peer-b（模拟成员所在节点掉线）');
    peerB.kill('SIGKILL');
    await waitExit(peerB);
    const roster2 = await client.query('roster', {});
    const members2 = dataOf(roster2).members;
    const peerBItem = members2.find((m) => m.memberId === 'peer-b');
    check(
        '掉线',
        peerBItem?.state === 'unknown' && peerBItem.reason === 'E_UNAVAILABLE' && members2.length === 2,
        `roster → ${rosterLine(members2)}（整体 ok=${roster2.ok}）`,
    );

    // ⑦ 崩溃重启：kill -9 房间节点，同一个数据目录再起 —— 状态从提交日志恢复
    say('⑦ kill -9 房间节点，然后用同一个数据目录重启');
    client.close();
    room.kill('SIGKILL');
    await waitExit(room);
    room = startNode(
        'room-node.ts',
        {
            DIY_DEMO_ROOM_SOCKET: roomSocket,
            DIY_DEMO_ROOM_URI: 'diy://demo/room',
            DIY_DEMO_ROOM_DATA: dataDir('room'),
        },
        'room',
    );
    await waitForSocket(roomSocket);
    client = await connectActor({ kind: roomKind, socket: roomSocket });
    const read3 = dataOf(await client.query('read', {}));
    check('重启恢复', read3.messages.length === 1, `重启后 read → messages=${read3.messages.length}`);

    // ⑧ 已知空洞：幂等表在内存里，重启就没了 —— 同一个 commandId 会再写一条
    say('⑧ 重启后重发**同一个** commandId（这是 docs/08 刀7 的空洞，不是本剧本的 bug）');
    doneOf(await client.cmd('post', { text: '大家好' }, { commandId: postId }));
    const read4 = dataOf(await client.query('read', {}));
    check(
        '已知空洞',
        read4.messages.length === 2,
        `重发 → messages=${read4.messages.length}（跨重启幂等没做：状态恢复了，幂等表没恢复）`,
    );

    // ⑨ 事件流：重启之后照样能补历史（事件和状态在同一个提交里）
    say('⑨ 事件流：补历史');
    const events: { seq: string; data: unknown }[] = [];
    const abort = new AbortController();
    for await (const event of client.watch({ include: ['posted'], signal: abort.signal })) {
        events.push({ seq: event.seq, data: event.data });
        if (events.length >= 2) break;
    }
    abort.abort();
    check('watch', events.length === 2, `posted×${events.length}（重启前 1 条 + 重启后 1 条，seq 连续）`);

    say('全部主张成立（九步）');

    client.close();
    await Promise.all(
        children.map(async (child) => {
            child.kill('SIGKILL');
            await waitExit(child);
        }),
    );
    rmSync(root, { recursive: true, force: true });
}

main().catch((err: unknown) => {
    console.error(`✘ 剧本失败：${err instanceof Error ? err.message : String(err)}`);
    for (const child of children) child.kill('SIGKILL');
    process.exitCode = 1;
});
