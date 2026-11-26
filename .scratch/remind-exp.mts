// remind-exp.mts —— 三档提醒的对照实验（在跑着的 lab 上换档，不用重启）
//
// 每档：写 <home>/units-remind.txt → 新建任务 → 只发一句**人的原话** → 等这轮跑完
//        → 记录：账本条数 / 每条 id+title+body 前 60 / units 节里有没有 hint
//
// 判据（人工看，脚本只负责收集事实）：
//   ① 有没有建账本   ② 首条是不是那句需求本身   ③ 条目是「需求级」还是「实现步骤」
import { ChannelClientBinding } from '@diy-agent/rpc';
import { WsTransport, connectWs } from '@diy-agent/rpc/ws/browser';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME_DIR ?? 'run/diy2/lab';
const URL = process.env.RPC ?? 'ws://127.0.0.1:62771/rpc';
const MODEL = process.env.MODEL ?? 'aug@opencode-go/deepseek-v4.1-flash';
const MODES = (process.env.MODES ?? 'off,a,c,b,abc').split(',');
const MSG =
    process.env.MSG ??
    '需要解决如何提示bot自动把需求和任务拆解，现在貌似不能自己做，非要提示「把这件事拆成几步」';

const flag = path.join(HOME, 'units-remind.txt');

let transport = new WsTransport(await connectWs(URL, { timeoutMs: 5_000 }));
let binding = new ChannelClientBinding(transport);

/** 调一次 RPC；连接断了就重连再试（dev server 改代码会自动重启，ws 会被掐） */
async function call<T = unknown>(method: string, input: unknown, retries = 3): Promise<T> {
    for (let i = 0; ; i += 1) {
        try {
            return await binding.invoke<unknown, T>(method, { input });
        } catch (e) {
            const msg = String((e as Error).message);
            if (i >= retries || !/DISPOSED|websocket|socket/i.test(msg)) throw e;
            await new Promise((r) => setTimeout(r, 2_000));
            try {
                transportransport.close();
            } catch {
                /* 已关 */
            }
            transport = new WsTransport(await connectWs(URL, { timeoutMs: 5_000 }));
            binding = new ChannelClientBinding(transport);
            console.log('   （连接断了，已重连）');
        }
    }
}
type Item = { type: string; data?: { name?: string; message?: string } };

// 找一个项目房间（task 必须挂在项目下）
const rooms = await call<unknown>('diy2.rooms.list', {});
const list = (Array.isArray(rooms) ? rooms : ((rooms as { rooms?: unknown[] }).rooms ?? [])) as Array<{
    id: string;
    type?: string;
}>;
const project = list.find((r) => r.type === 'project');
if (project === undefined) throw new Error('没有项目房间，无法建任务');
console.log('project =', project.id, '| model =', MODEL);

for (const mode of MODES) {
    if (mode === 'default') rmSync(flag, { force: true });
    else writeFileSync(flag, mode, 'utf8');

    const room = await call<{ id: string }>('diy2.rooms.create', {
            name: `提醒-${mode}-${new Date().toISOString().slice(11, 19)}`,
            type: 'task',
            modelKey: MODEL,
            data: { projectId: project.id },
        },
    });
    const t0 = Date.now();
    await call('diy2.chat.chat', { id: room.id, text: MSG });

    const tools: string[] = [];
    let hintAtStart = '';
    let lastLen = 0;
    let quiet = 0;
    for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        if (i === 0) {
            const early = await call<{ text: string }>('diy2.units.text', { id: room.id });
            hintAtStart = /hint/.test(early.text) ? early.text.split('\n').find((l) => l.includes('hint')) ?? 'hint(有)' : '';
        }
        const h = await call<{ items?: Item[] }>('diy2.chat.history', { id: room.id });
        const items = h.items ?? [];
        for (const it of items.slice(lastLen)) {
            if (it.type === 'tool' && it.data?.name !== undefined) tools.push(it.data.name);
            if (it.type === 'error') console.log('   ERROR:', (it.data?.message ?? '').slice(0, 90));
        }
        quiet = items.length === lastLen ? quiet + 1 : 0;
        lastLen = items.length;
        // 安静 60s 视为这一轮结束（长任务会被切到后台，但账本能看出来）
        if (quiet >= 12) break;
    }

    type Row = { id: string; title: string; body: string; status: string; parent: string | null };
    const board = await call<{ rows: Row[] }>('diy2.units.list', { id: room.id });
    const text = await call<{ text: string }>('diy2.units.text', { id: room.id });

    console.log(`\n=== mode=${mode} · ${((Date.now() - t0) / 1000).toFixed(0)}s · units=${board.rows.length} · room=${room.id}`);
    console.log(`  工具：${[...new Set(tools)].join(',') || '(无)'}（共 ${tools.length} 次）`);
    const hasHint = /hint:/.test(text.text);
    console.log(`  收尾时 units 节 hint：${hasHint ? '有' : '没有'}；第一条轮询时的 hint：${hintAtStart || '没有'}`);
    for (const row of board.rows) {
        console.log(`  · [${row.status}] ${row.parent === null ? '' : `(${row.parent}) `}${row.title}`);
        if (row.body !== '') console.log(`      ${row.body.replace(/\n/g, ' ').slice(0, 150)}`);
    }
}

rmSync(flag, { force: true });
t.close();
