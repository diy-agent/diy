// unitBoardList.test.tsx —— 「目标」左栏的拍平 + 当前/历史分开（2026-11-27 用户裁）。
//
// 三条要钉住（都是真渲一遍才看得见的）：
//   1. **拍平**：左栏只列根需求；子需求（小目标）不铺在左栏 —— 它只在点开父条目时出现
//   2. **当前 / 历史分开**：done 的根需求默认不列，收在一行「历史 N」后面，展开才出来
//   3. **小目标可点**：详情里「小目标」块列出子条目，点一下换 tab（回调带 id + title）
//
// 判据只认渲染出来的 html：这些是布局决定，不是纯函数 —— 单测纯函数测不到「它到底画没画」。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { UnitBoardView as Board, UnitDetailView, UnitItem } from '@diy-agent/chat-transport-rpc';

const board = { value: null as Board | null };

vi.mock('../src/useUnitBoard', () => ({
    useUnitBoard: () => ({ board: board.value, error: null }),
}));
vi.mock('../src/useUnitText', () => ({
    useUnitText: () => ({ view: null, error: null }),
}));
vi.mock('../src/useUnitDetail', () => ({
    useUnitDetail: () => ({ detail: detail.value, error: null }),
}));
vi.mock('../src/useUnitRaw', () => ({
    useUnitRaw: () => ({ raw: null, error: null }),
}));

const detail = { value: null as UnitDetailView | null };

const { UnitBoardView } = await import('../src/components/UnitBoardView');
const { UnitNeedDetail } = await import('../src/components/UnitNeedDetail');

function unit(id: string, extra: Partial<UnitItem> = {}): UnitItem {
    return {
        id,
        kind: 'need',
        title: `需求 ${id}`,
        body: '',
        accept: '有验收',
        source: '',
        status: 'open',
        parent: null,
        children: [],
        steps: [],
        group: false,
        depth: 0,
        seq: 1,
        ...extra,
    };
}

function boardOf(rows: UnitItem[]): Board {
    return { rows, roots: rows.map((row) => row.id), ready: [], doing: [], done: [], groups: [], danglingParents: [] };
}

const room = { id: 'task-1', type: 'task', name: '任务', data: {} } as never;

describe('目标左栏：拍平 + 当前/历史分开', () => {
    it('只列根需求：子需求不铺在左栏（点开父条目才出现）', () => {
        board.value = boardOf([
            unit('parent-goal'),
            unit('child-goal', { parent: 'parent-goal', depth: 1 }),
        ]);
        const html = renderToStaticMarkup(<UnitBoardView room={room} />);
        expect(html).toContain('需求 parent-goal');
        expect(html).not.toContain('需求 child-goal');
    });

    it('done 的根需求默认收在「历史 N」里，open/doing 直接列', () => {
        board.value = boardOf([
            unit('live', { status: 'doing' }),
            unit('done-one', { status: 'done' }),
            unit('done-two', { status: 'done' }),
        ]);
        const html = renderToStaticMarkup(<UnitBoardView room={room} />);
        expect(html).toContain('需求 live');
        expect(html).not.toContain('需求 done-one');
        expect(html).toContain('历史 2');
    });
});

describe('详情里的「小目标」', () => {
    it('列子条目；点一下把 id + title 交回去（宿主据此换 tab）', () => {
        const opened: Array<[string, string]> = [];
        detail.value = {
            need: unit('parent-goal'),
            children: [{ id: 'child-goal', title: '小目标 A', status: 'doing', accept: '' }],
            decisions: [],
            notes: [],
        };
        const html = renderToStaticMarkup(
            <UnitNeedDetail roomId="task-1" unitId="parent-goal" onOpenUnit={(id, title) => opened.push([id, title])} />,
        );
        expect(html).toContain('小目标');
        expect(html).toContain('小目标 A');
        expect(html).toContain('缺验收');
    });

    it('没有子条目时不画空块', () => {
        detail.value = { need: unit('solo'), children: [], decisions: [], notes: [] };
        const html = renderToStaticMarkup(<UnitNeedDetail roomId="task-1" unitId="solo" />);
        expect(html).not.toContain('小目标');
    });
});
