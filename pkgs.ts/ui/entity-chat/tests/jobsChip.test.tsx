// jobsChip.test.tsx —— 底栏那枚「后台任务」chip 的空状态（用户 2026-11-24 裁）。
//
// 用户原话：「作业跑完了需要消失，只需要 0 空状态即可，这样还能点进去看历史」——
// 前半句说的是**那个跳动的绿点**要消失，不是整枚 chip。所以钉住两件事：
//   1. 0 条在跑时 chip **仍然占位置**（第一版这里是 `return null`，等于把进历史账本的
//      唯一入口也一起藏了）；
//   2. 0 条在跑时**不动**（没有 animate-ping）、也不写数字和时长 —— 空状态就长得像空状态。
//
// SSR 到字符串（仓库里 entity-chat 的既有姿势，没有 jsdom）：effect 不跑 ⇒ rows 恒为 []，
// 正好就是「什么都没在跑」。

import type { JobRunRow } from '@diy-agent/chat-transport-rpc';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { belongsToRoom, JobsChip } from '../src/components/JobsChip';

describe('作业 chip 的空状态', () => {
    it('没有作业在跑时仍然渲染（历史账本的入口不许跟着消失）', () => {
        const html = renderToStaticMarkup(<JobsChip />);
        // 2026-11-24 改名：「作业」→「后台任务」，并写清口径（本房间 / 本实例全部）
        expect(html).toContain('后台任务');
        expect(html).toContain('<button');
    });

    it('空状态不动、不写数字：没有跳动的点', () => {
        const html = renderToStaticMarkup(<JobsChip />);
        expect(html).not.toContain('animate-ping');
        expect(html).not.toContain('tabular-nums'); // 时长那一段（`3m20s`）只在有在跑的时出现
    });

    it('title 说清「点开看的是历史」', () => {
        const html = renderToStaticMarkup(<JobsChip />);
        expect(html).toContain('现在没有在跑的');
    });
});

// 房间入口（chip / 抽屉 `scope="room"`）只看本房间起的作业；标题栏的 JobsPanel 不滤。
// 原来 chip 的 title 已经写着「本房间」但拉的是实例全量 —— 文案与数据不一致，这条锁住数据。
describe('belongsToRoom —— 按 origin.taskUri 首段收窄', () => {
    const roomId = '01a2091d-a9b0-7747-aacc-0b53dd48ee4c';

    const rowOf = (origin?: { taskUri: string; turnId?: string }): JobRunRow => ({
        id: 'r-1',
        state: 'exited',
        startedAt: 0,
        durationMs: 1_000,
        command: 'echo hi',
        cwd: '/tmp',
        logPath: '/tmp/out.log',
        ...(origin === undefined ? {} : { origin }),
    });

    it('同房间（新 uuid 形态）→ 算本房间的', () => {
        expect(belongsToRoom(rowOf({ taskUri: `${roomId}#bot-1` }), roomId)).toBe(true);
    });

    it('别的房间 → 不算（多任务并行时不看别人的活）', () => {
        // 旧形态 `task-mwjddcy0` 同样是房间 id（在 rooms_v0 里查得到）
        expect(belongsToRoom(rowOf({ taskUri: 'task-mwjddcy0#bot-2' }), roomId)).toBe(false);
    });

    it('# 后面的 bot id 不参与判定（同房间换个 bot 仍算）', () => {
        expect(belongsToRoom(rowOf({ taskUri: `${roomId}#bot-anything` }), roomId)).toBe(true);
    });

    it('首屏还没定位到房间（roomId 空）→ 不滤，否则历史全没了', () => {
        expect(belongsToRoom(rowOf({ taskUri: 'task-x#bot-1' }), '')).toBe(true);
    });

    it('没有 origin → 不滤（归属未知时宁可多显示）', () => {
        expect(belongsToRoom(rowOf(), roomId)).toBe(true);
    });
});
