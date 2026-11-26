// exportMarkdown —— 时间线 → Markdown：导出文件长什么样，只能靠这几条钉住。
//
// 断言的粒度是「整段文本包含什么」而不是逐字全文：排版微调（多一个空行）不该红，
// 但**内容缺失 / 归属错 / 时间戳丢**必须红 —— 那是导出不可信的起点。

import type { TimelineEntry, TimelinePart } from '@diy-agent/chat-core';
import { describe, expect, it } from 'vitest';

import { exportFileName, roomToMarkdown } from '../src/exportMarkdown';
import { type Bot, type Room } from '../src/model';

const AT = (hour: number, minute = 0): number => new Date(2026, 10, 26, hour, minute).getTime();

const bot = (id: string, name: string): Bot => ({
    id,
    name,
    color: '#fff',
    persona: '',
    homeRoomId: 'home',
    modelKey: 'm',
});

const bots: Record<string, Bot> = {
    'bot-dsh': bot('bot-dsh', 'dsh'),
    'bot-helper': bot('bot-helper', 'helper'),
};

function room(over: Partial<Room> = {}): Room {
    return {
        id: 'task:12',
        type: 'task',
        data: { title: '加个导出', number: 12, status: 'open', dir: '~/git/diy/diy' },
        members: [{ botId: 'bot-dsh', primary: true }, { botId: 'bot-helper' }],
        modelKey: 'm',
        ...over,
    };
}

function entry(over: Partial<TimelineEntry> & { parts: TimelinePart[] }): TimelineEntry {
    return {
        key: 'k',
        kind: 'assistant',
        turnId: 't1',
        parts: [],
        streaming: false,
        deliveries: [],
        at: AT(9),
        ...over,
    };
}

const human = { id: 'me', name: '我', color: '#000', role: 'human' as const };
const dsh = { id: 'bot-dsh', name: 'dsh', color: '#fff', role: 'bot' as const };

describe('roomToMarkdown 抬头', () => {
    it('房间名来自容器、带编号 / 状态 / 成员 / 条目数 / 导出时刻', () => {
        const text = roomToMarkdown({ room: room(), bots, entries: [], exportedAt: AT(10, 5) });
        expect(text).toContain('# 加个导出');
        expect(text).toContain('任务 #12');
        expect(text).toContain('状态：open');
        expect(text).toContain('目录：`~/git/diy/diy`');
        expect(text).toContain('成员：dsh（默认应答）、helper');
        expect(text).toContain('条目：0 条');
        expect(text).toContain('导出：2026-11-26 10:05');
        expect(text).toContain('_（这个房间还没有内容）_');
    });

    it('项目房间没有任务编号那一行（编号只对 task 成立）', () => {
        const text = roomToMarkdown({
            room: room({ type: 'project', data: { name: 'diy' }, members: [] }),
            bots,
            entries: [],
            exportedAt: AT(10),
        });
        expect(text).toContain('# diy');
        expect(text).not.toContain('任务 #');
        expect(text).not.toContain('状态：');
        expect(text).toContain('成员：（无）');
    });
});

describe('roomToMarkdown 逐条渲染', () => {
    it('用户与 bot 各自一段，首次出现带日期、同日只写时刻', () => {
        const text = roomToMarkdown({
            room: room(),
            bots,
            exportedAt: AT(10),
            entries: [
                entry({
                    key: 'u1',
                    kind: 'user',
                    author: human,
                    parts: [{ kind: 'text', text: '第一句' }],
                    at: AT(9, 1),
                }),
                entry({ key: 'a1', author: dsh, parts: [{ kind: 'text', text: '收到' }], at: AT(9, 2) }),
                entry({
                    key: 'u2',
                    kind: 'user',
                    author: human,
                    parts: [{ kind: 'text', text: '第二句' }],
                    at: AT(9, 3),
                }),
            ],
        });
        expect(text).toContain('## 用户 · 2026-11-26 09:01\n\n第一句');
        expect(text).toContain('## dsh · 09:02\n\n收到');
        // 跨到同一天的第二条：不再重复日期
        expect(text).toContain('## 用户 · 09:03\n\n第二句');
        expect(text.match(/2026-11-26/g)?.length).toBe(2); // 抬头 1 + 首条 1
    });

    it('工具行一列：名字 + target + 状态；失败另标', () => {
        const text = roomToMarkdown({
            room: room(),
            bots,
            exportedAt: AT(10),
            entries: [
                entry({
                    author: dsh,
                    at: AT(9, 1),
                    parts: [
                        { kind: 'tool', id: 'tool-1', name: 'read', args: { path: '/a/b/c.ts' }, state: 'ok' },
                        {
                            kind: 'tool',
                            id: 'tool-2',
                            name: 'bash',
                            args: { command: 'npm test && echo ok' },
                            state: 'error',
                        },
                    ],
                }),
            ],
        });
        expect(text).toContain('- ✓ `read`：`c.ts`');
        expect(text).toContain('- ✗ 失败 `bash`：`npm test`');
    });

    it('提问：选项、已选、待回答三种状态都写出来', () => {
        const request = {
            askId: 'ask-1',
            questions: [
                {
                    id: 'q1',
                    question: '导到哪？',
                    kind: 'choice' as const,
                    options: [{ value: 'dl', label: '下载目录' }],
                },
            ],
            at: AT(9, 2),
        };
        const answered = roomToMarkdown({
            room: room(),
            bots,
            exportedAt: AT(10),
            entries: [
                entry({
                    author: dsh,
                    at: AT(9, 2),
                    parts: [
                        {
                            kind: 'ask',
                            request,
                            answer: { answers: [{ id: 'q1', values: ['dl'] }] },
                        },
                    ],
                }),
            ],
        });
        expect(answered).toContain('> **导到哪？**');
        expect(answered).toContain('> - **[已选]** `dl` 下载目录');

        const pending = roomToMarkdown({
            room: room(),
            bots,
            exportedAt: AT(10),
            entries: [entry({ author: dsh, at: AT(9, 2), parts: [{ kind: 'ask', request }] })],
        });
        expect(pending).toContain('> → 待回答');

        const expired = roomToMarkdown({
            room: room(),
            bots,
            exportedAt: AT(10),
            entries: [
                entry({
                    author: dsh,
                    at: AT(9, 2),
                    parts: [{ kind: 'ask', request, expired: true, reason: '已经继续工作了' }],
                }),
            ],
        });
        expect(expired).toContain('> → 已过期：已经继续工作了');
    });

    it('通知与错误：通知引用一行，轮级错误单独一段', () => {
        const text = roomToMarkdown({
            room: room(),
            bots,
            exportedAt: AT(10),
            entries: [
                entry({
                    key: 'n1',
                    kind: 'notice',
                    turnId: 't0',
                    parts: [{ kind: 'text', text: '已压缩 12 条' }],
                    at: AT(9, 1),
                }),
                entry({
                    key: 'e1',
                    kind: 'error',
                    turnId: 't1',
                    parts: [{ kind: 'text', text: '上游 429' }],
                    at: AT(9, 2),
                }),
                entry({ author: dsh, at: AT(9, 3), parts: [{ kind: 'error', message: '工具超时' }] }),
            ],
        });
        expect(text).toContain('> 已压缩 12 条');
        expect(text).toContain('## 错误 · 09:02\n\n> 上游 429');
        // bot 自己的失败是那条回复的一部分
        expect(text).toContain('## dsh · 09:03\n\n> ⚠️ 失败：工具超时');
    });

    it('作业通知与后台作业工具都画成作业行（带 run id / 结局）', () => {
        const text = roomToMarkdown({
            room: room(),
            bots,
            exportedAt: AT(10),
            entries: [
                entry({
                    kind: 'notice',
                    turnId: 't1',
                    at: AT(9, 1),
                    parts: [{ kind: 'text', text: '原文' }],
                    job: { run: 'r-7', state: 'exited', exitCode: 0, durationMs: 1200, command: 'npm test' },
                }),
                entry({
                    author: dsh,
                    at: AT(9, 2),
                    parts: [
                        {
                            kind: 'tool',
                            id: 'tool-9',
                            name: 'bash',
                            args: { command: 'npm run build', background: true },
                            state: 'ok',
                        },
                    ],
                }),
            ],
        });
        expect(text).toContain('**作业** `r-7` 已结束（退出码 0） · 1.2s · 命令 `npm test`');
        expect(text).toContain('**作业**');
    });

    it('「正在输入」占位导出成一行说明，不丢那一轮', () => {
        const text = roomToMarkdown({
            room: room(),
            bots,
            exportedAt: AT(10),
            entries: [entry({ kind: 'typing', author: dsh, at: AT(9, 1) })],
        });
        // 第一条当然带日期（同「首次出现带日期」那条规则）
        expect(text).toContain('_dsh 正在运行（尚无内容）· 2026-11-26 09:01_');
    });

    it('未送达的投递标在用户那条下面', () => {
        const text = roomToMarkdown({
            room: room(),
            bots,
            exportedAt: AT(10),
            entries: [
                entry({
                    kind: 'user',
                    author: human,
                    at: AT(9, 1),
                    parts: [{ kind: 'text', text: '在吗' }],
                    deliveries: [{ botId: 'bot-helper', name: 'helper', color: '#fff', state: 'failed' }],
                }),
            ],
        });
        expect(text).toContain('_未送达：helper_');
    });
});

describe('exportFileName', () => {
    it('房间名 + 时间戳，路径分隔符之类的字符被换掉', () => {
        const name = exportFileName(room({ data: { title: '修 a/b: c?' } }), bots, AT(9, 33));
        expect(name).toBe('修 a-b- c-20261126-0933.md');
    });

    it('没有名字时退到房间 id（文件名不能是空的）', () => {
        expect(exportFileName(room({ id: 'room-1', data: {} }), {}, AT(9, 5))).toBe('room-1-20261126-0905.md');
    });
});
