import { describe, expect, it } from 'vitest';
import { openStore, type TaskInput } from '../src/db';
import type { Room } from '../src/types';

const room: Room = {
    id: 'task-abc',
    type: 'task',
    data: { title: '新任务 2', status: 'open', projectId: 'proj:diy', dir: '~/git/diy/diy' },
    members: [{ botId: 'b1', primary: true }, { botId: 'b2' }],
    modelKey: 'm',
};

/** 任务输入的最小合法形状（number / createdAt 交给 store 补） */
function taskInput(id: string, extra: Partial<TaskInput> = {}): TaskInput {
    return {
        id,
        title: id,
        summary: '',
        body: '',
        projectId: null,
        workspace: null,
        status: 'open',
        closedAt: null,
        modelKey: 'm',
        ...extra,
    };
}

describe('rooms 持久化', () => {
    it('saveRoom → listRooms 回到同样的元数据（含成员）', () => {
        const store = openStore(':memory:');
        store.setMembers(room.id, room.members);
        store.saveRoom(room);
        const [saved] = store.listRooms();
        // 任务号是 store 分配的，Room 上以只读字段出现
        expect(saved).toMatchObject(room);
        expect(saved?.data['number']).toBe(1);
    });

    it('改名 / 换模型是 upsert，不会多出一行', () => {
        const store = openStore(':memory:');
        store.saveRoom(room);
        store.saveRoom({ ...room, data: { ...room.data, title: '改名后' }, modelKey: 'm2' });
        const rooms = store.listRooms();
        expect(rooms).toHaveLength(1);
        expect(rooms[0]).toMatchObject({ data: { title: '改名后' }, modelKey: 'm2' });
    });

    it('Room.data 里的未知键不再被存回去（core 已无开放袋子）', () => {
        const store = openStore(':memory:');
        store.saveRoom({ ...room, data: { ...room.data, parent: 'task-other', legacy: 'diy1 残留' } });
        const saved = store.listRooms()[0];
        expect(saved?.data).not.toHaveProperty('parent');
        expect(saved?.data).not.toHaveProperty('legacy');
    });
});

describe('删除容器', () => {
    it('deleteRoom 连带清掉消息 / 日志 / 成员 / 会话 / 投递（不留孤儿行）', () => {
        const store = openStore(':memory:');
        store.setMembers(room.id, room.members);
        store.saveRoom(room);
        store.appendItem(room.id, {
            id: 'msg-1',
            seq: 0,
            turnId: 't1',
            type: 'chat',
            at: Date.now(),
            status: 'done',
            author: { id: 'human:我', name: '我', color: '#000', role: 'human' },
            data: { text: '一句话' },
        });
        store.appendRoomEntry(room.id, { seq: 1, at: Date.now(), kind: 'notice', text: '结论' });
        store.saveSession(room.id, 'b1', { turn: 1, collapsed: 0, entries: [] });
        store.setDelivery({ roomId: room.id, messageId: 'msg-1', botId: 'b1', state: 'delivered' });

        store.deleteRoom(room.id);

        expect(store.listRooms()).toEqual([]);
        expect(store.itemsOf(room.id)).toEqual([]);
        expect(store.roomEntries(room.id)).toEqual([]);
        expect(store.members()[room.id]).toBeUndefined();
        expect(store.loadSession(room.id, 'b1')).toBeUndefined();
        expect(store.listDeliveries(room.id)).toEqual([]);
    });

    it('deleteBot 只删那一个身份', () => {
        const store = openStore(':memory:');
        store.upsertBot({ id: 'b1', name: 'a', color: '#000', persona: 'p', homeRoomId: 'r', modelKey: 'm' });
        store.upsertBot({ id: 'b2', name: 'b', color: '#111', persona: 'p', homeRoomId: 'r', modelKey: 'm' });
        store.deleteBot('b1');
        expect(store.listBots().map((bot) => bot.id)).toEqual(['b2']);
    });
});

describe('草稿', () => {
    it('putDraft → listDrafts 原样读回，重复写是覆盖不是新增', () => {
        const store = openStore(':memory:');
        store.putDraft(room.id, 'composer', { text: '打到一半' });
        store.putDraft(room.id, 'composer', { text: '改了一版' });
        expect(store.listDrafts(room.id)).toEqual([
            { field: 'composer', value: { text: '改了一版' }, updatedAt: expect.any(Number) },
        ]);
    });

    it('空内容 = 删除；显式 deleteDraft 也删', () => {
        const store = openStore(':memory:');
        store.putDraft(room.id, 'composer', { text: 'x' });
        store.putDraft(room.id, 'composer', { text: '   ' });
        expect(store.listDrafts(room.id)).toEqual([]);

        store.putDraft(room.id, 'composer', { text: 'y' });
        store.deleteDraft(room.id, 'composer');
        expect(store.listDrafts(room.id)).toEqual([]);
    });

    it('draftOwnersByKind 只列真正有内容的容器，且把 ask 与输入分开', () => {
        const store = openStore(':memory:');
        store.putDraft('proj:a', 'composer', { text: '没发出去' });
        store.putDraft('proj:b', 'composer', { text: '' });
        store.putDraft('proj:a', 'ask:ask-1', { selected: ['x'] });
        // 提问填了一半：归 ask，不进 input —— 侧栏 ✎ 不为提问亮（卡片本来就在时间线上）
        expect(store.draftOwnersByKind()).toEqual({ input: ['proj:a'], ask: ['proj:a'] });
    });

    it('deleteRoom 连带清掉草稿', () => {
        const store = openStore(':memory:');
        store.saveRoom(room);
        store.putDraft(room.id, 'composer', { text: 'x' });
        store.deleteRoom(room.id);
        expect(store.listDrafts(room.id)).toEqual([]);
        expect(store.draftOwnersByKind()).toEqual({ input: [], ask: [] });
    });

    it('pruneAskDrafts 只清「时间线上不再等回答」的旧 ask 草稿', () => {
        const store = openStore(':memory:');
        const old = Date.now() - 60 * 60 * 1000;
        const fresh = Date.now();
        store.putDraft(room.id, 'ask:gone', { selected: ['a'] });
        store.putDraft(room.id, 'ask:pending', { selected: ['b'] });
        store.putDraft(room.id, 'ask:recent', { selected: ['c'] });
        store.putDraft(room.id, 'composer', { text: '别动我' });
        // 手动回拨时间：真实场景里是"很久没动过"
        store.db.prepare('UPDATE drafts SET updated_at = ? WHERE field = ?').run(old, 'ask:gone');
        store.db.prepare('UPDATE drafts SET updated_at = ? WHERE field = ?').run(old, 'ask:pending');

        // 只保留还在等回答的 ask:pending；ask:recent 太新，这轮不动
        const removed = store.pruneAskDrafts(room.id, new Set(['pending']), Date.now() - 30 * 60 * 1000);
        expect(removed).toBe(1);
        expect(
            store
                .listDrafts(room.id)
                .map((draft) => draft.field)
                .sort(),
        ).toEqual(['ask:pending', 'ask:recent', 'composer']);
        expect(fresh).toBeGreaterThan(0);
    });

    it('pruneDraftOwners 按前缀 + 时间清 synthetic scope（不碰真实房间）', () => {
        const store = openStore(':memory:');
        const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
        store.putDraft('dlg:create-task:proj:diy', 'desc', { text: '忘了关的对话框' });
        store.putDraft('dlg:create-task:proj:cops', 'desc', { text: '刚写的' });
        store.putDraft(room.id, 'composer', { text: '房间草稿' });
        store.db.prepare("UPDATE drafts SET updated_at = ? WHERE owner_id = 'dlg:create-task:proj:diy'").run(old);

        const removed = store.pruneDraftOwners('dlg:', Date.now() - 7 * 24 * 60 * 60 * 1000);
        expect(removed).toBe(1);
        expect(store.draftOwnersByKind().input).toEqual(['dlg:create-task:proj:cops', room.id]);
    });

    it('deleteRoom 连带清掉挂在这个房间后面的对话框草稿', () => {
        const store = openStore(':memory:');
        store.saveRoom(room);
        store.putDraft('dlg:create-task:' + room.id, 'desc', { text: '写了一半' });
        store.putDraft('dlg:create-task:proj:other', 'desc', { text: '别人的' });
        store.deleteRoom(room.id);
        expect(store.draftOwnersByKind().input).toEqual(['dlg:create-task:proj:other']);
    });

    it('坏 JSON 行跳过，不影响同房间其他草稿', () => {
        const store = openStore(':memory:');
        store.putDraft(room.id, 'composer', { text: '好行' });
        store.db
            .prepare('INSERT INTO drafts (owner_id, field, value, updated_at) VALUES (?,?,?,?)')
            .run(room.id, 'ask:bad', '{不是 json', Date.now());
        expect(store.listDrafts(room.id).map((draft) => draft.field)).toEqual(['composer']);
    });
});

// 侧栏「最后活动」的数据源：一次聚合查出每个容器的最后一条 item，避免逐房间 N+1。
// 语义边界（刻意如此）：改名字 / 改状态 / 加成员**不**产生 item，也就不算活动。
describe('lastItemAtByRoom —— 每个容器的最后活动', () => {
    function msg(id: string, at: number) {
        return {
            id,
            seq: 0,
            turnId: 't1',
            type: 'chat' as const,
            at,
            status: 'done' as const,
            author: { id: 'human:我', name: '我', color: '#000', role: 'human' as const },
            data: { text: id },
        };
    }

    it('取每个容器最大的 at；没聊过的容器不出现在结果里', () => {
        const store = openStore(':memory:');
        store.appendItem('task-a', msg('a1', 1_000));
        store.appendItem('task-a', msg('a2', 3_000));
        store.appendItem('task-b', msg('b1', 2_000));
        expect(store.lastItemAtByRoom()).toEqual({ 'task-a': 3_000, 'task-b': 2_000 });
    });

    it('后写的 item 时刻更早也不影响（取 MAX 而不是最后一行）', () => {
        const store = openStore(':memory:');
        store.appendItem('task-a', msg('a1', 9_000));
        store.appendItem('task-a', msg('a2', 1_000));
        expect(store.lastItemAtByRoom()).toEqual({ 'task-a': 9_000 });
    });

    it('删掉容器后它的活动也跟着消失', () => {
        const store = openStore(':memory:');
        store.saveRoom({ ...room, id: 'task-a' });
        store.appendItem('task-a', msg('a1', 5_000));
        store.deleteRoom('task-a');
        expect(store.lastItemAtByRoom()).toEqual({});
    });
});

describe('任务日志（journal）', () => {
    it('append 自增；journalOf 时间正序、limit 取最近 N 条', () => {
        const store = openStore(':memory:');
        store.saveRoom(room);
        const a = store.appendJournal(room.id, { kind: 'decision', text: '选了 A' });
        const b = store.appendJournal(room.id, { kind: 'pitfall', text: 'B 会炸' });
        expect(b.seq).toBeGreaterThan(a.seq);

        const all = store.journalOf(room.id);
        expect(all.map((entry) => entry.text)).toEqual(['选了 A', 'B 会炸']);

        const last = store.journalOf(room.id, 1);
        expect(last).toHaveLength(1);
        expect(last[0]!.text).toBe('B 会炸');
    });

    it('journal 是 events 的投影：event = <type>.journal，data = {kind,text}', () => {
        const store = openStore(':memory:');
        store.saveRoom(room);
        store.appendJournal(room.id, { kind: 'decision', text: '选了 A' });
        const row = store.db.prepare('SELECT event, subject, actor, data FROM events').get() as Record<string, unknown>;
        expect(row['event']).toBe('task.journal');
        expect(row['subject']).toBe(room.id);
        expect(row['actor']).toBeNull();
        expect(JSON.parse(String(row['data']))).toEqual({ kind: 'decision', text: '选了 A' });
    });

    it('删房间连带清掉日志', () => {
        const store = openStore(':memory:');
        store.saveRoom(room);
        store.appendJournal(room.id, { kind: 'progress', text: 'x' });
        store.deleteRoom(room.id);
        expect(store.journalOf(room.id)).toEqual([]);
    });
});

describe('实体 + 域表', () => {
    it('saveTask 分配递增编号；同一 id 再存仍是原号', () => {
        const store = openStore(':memory:');
        const a = store.saveTask(taskInput('t-a'));
        const b = store.saveTask(taskInput('t-b'));
        expect([a.number, b.number]).toEqual([1, 2]);
        expect(store.saveTask({ ...taskInput('t-a'), title: '改名' }).number).toBe(1);
        expect(store.taskOf('t-a')?.title).toBe('改名');
    });

    it('删掉任务后编号不回收（counters 独立于任务行）', () => {
        const store = openStore(':memory:');
        const a = store.saveTask(taskInput('t-a'));
        store.deleteRoom(a.id);
        expect(store.saveTask(taskInput('t-b')).number).toBe(2);
    });

    it('身份行与域行 1:1；删实体带走域行，不碰别的实体', () => {
        const store = openStore(':memory:');
        store.saveTask(taskInput('t-a'));
        store.saveProject({ id: 'p-a', name: 'p', workspace: null, modelKey: 'm' });
        expect(store.entityOf('t-a')).toMatchObject({ type: 'task' });
        expect(store.entityOf('p-a')).toMatchObject({ type: 'project' });

        store.deleteRoom('t-a');
        expect(store.entityOf('t-a')).toBeUndefined();
        expect(store.taskOf('t-a')).toBeUndefined();
        expect(store.entityOf('p-a')).toBeDefined();
    });

    it('Room 只承载 project / task；别的类型要报错（不静默丢数据）', () => {
        const store = openStore(':memory:');
        expect(() => store.saveRoom({ ...room, type: 'stock' })).toThrow(/project \/ task/);
    });

    it('项目只是任务的字段：改项目不动任务的工作目录', () => {
        const store = openStore(':memory:');
        store.saveProject({ id: 'p', name: 'p', workspace: '~/a', modelKey: 'm' });
        store.saveTask(taskInput('t', { projectId: 'p', workspace: '~/worktree' }));
        store.saveProject({ id: 'p', name: 'p', workspace: '~/b', modelKey: 'm' });
        expect(store.taskOf('t')?.workspace).toBe('~/worktree');
        expect(store.projectOf('p')?.workspace).toBe('~/b');
    });

    it('bot 也是实体：upsertBot 写身份行，deleteBot 带走', () => {
        const store = openStore(':memory:');
        store.upsertBot({ id: 'b1', name: 'a', color: '#000', persona: 'p', homeRoomId: 'r', modelKey: 'm' });
        expect(store.entityOf('b1')).toMatchObject({ type: 'bot' });
        store.deleteBot('b1');
        expect(store.entityOf('b1')).toBeUndefined();
    });

    it('updated_at 只在内容变了才动（启动时的重复保存不算）', () => {
        const store = openStore(':memory:');
        expect(store.saveTask(taskInput('t', { updatedAt: 1_000 })).updatedAt).toBe(1_000);
        // 同样的内容再存一遍（actorOf 每次启动都这么干）：不盖时间
        expect(store.saveTask(taskInput('t', { updatedAt: 2_000 })).updatedAt).toBe(1_000);
        expect(store.saveTask(taskInput('t', { updatedAt: 3_000, title: '改名' })).updatedAt).toBe(3_000);
    });
});

describe('实体关系（替代父子）', () => {
    it('link / linksOf：出边入边都算（不要求手写反向）', () => {
        const store = openStore(':memory:');
        store.saveTask(taskInput('a'));
        store.saveTask(taskInput('b'));
        store.link('a', 'b', 'related');

        expect(store.linksOf('a')).toEqual({ out: [{ from: 'a', to: 'b', kind: 'related' }], in: [] });
        expect(store.linksOf('b')).toEqual({ out: [], in: [{ from: 'a', to: 'b', kind: 'related' }] });
    });

    it('重复建边幂等；unlink 返回是否真删了', () => {
        const store = openStore(':memory:');
        store.saveTask(taskInput('a'));
        store.saveTask(taskInput('b'));
        store.link('a', 'b', 'related');
        store.link('a', 'b', 'related');
        expect(store.linksOf('a').out).toHaveLength(1);

        expect(store.unlink('a', 'b', 'related')).toBe(true);
        expect(store.unlink('a', 'b', 'related')).toBe(false);
    });

    it('kind：core 三种之外必须带插件命名空间', () => {
        const store = openStore(':memory:');
        store.saveTask(taskInput('a'));
        store.saveTask(taskInput('b'));
        expect(() => store.link('a', 'b', 'parent')).toThrow(/kind 不合法/);
        expect(store.link('a', 'b', '@acme/github/implements')).toMatchObject({ kind: '@acme/github/implements' });
    });

    it('自连 / 实体不存在 / blocks 成环都拒绝', () => {
        const store = openStore(':memory:');
        for (const id of ['a', 'b', 'c']) store.saveTask(taskInput(id));

        expect(() => store.link('a', 'a', 'related')).toThrow(/自己/);
        expect(() => store.link('a', 'ghost', 'related')).toThrow(/不存在/);

        store.link('a', 'b', 'blocks');
        store.link('b', 'c', 'blocks');
        expect(() => store.link('c', 'a', 'blocks')).toThrow(/成环/);
        // related 不查环：纯关联允许互相指
        store.link('b', 'a', 'related');
    });

    it('删实体带走它的关系（from / to 两个方向）', () => {
        const store = openStore(':memory:');
        store.saveTask(taskInput('a'));
        store.saveTask(taskInput('b'));
        store.link('a', 'b', 'related');
        store.deleteRoom('a');
        expect(store.linksOf('b')).toEqual({ out: [], in: [] });
    });
});

describe('提问（asks）持久化', () => {
    const askOf = (askId: string, at: number) => ({
        askId,
        questions: [{ id: 'q1', question: '选哪个？', kind: 'choice' as const }],
        at,
    });

    it('putAsk → asksOf 原样读回；收尾后状态与答案都在', () => {
        const store = openStore(':memory:');
        const request = askOf('ask-1', 100);
        store.putAsk({ askId: 'ask-1', entityId: room.id, at: 100, request, state: 'pending' });
        expect(store.asksOf(room.id)).toEqual([
            { askId: 'ask-1', entityId: room.id, at: 100, request, state: 'pending' },
        ]);

        const answer = { answers: [{ id: 'q1', values: ['a'] }] };
        store.putAsk({
            askId: 'ask-1',
            entityId: room.id,
            at: 100,
            request,
            state: 'answered',
            answer,
            settledAt: 200,
        });
        expect(store.asksOf(room.id)[0]).toMatchObject({ state: 'answered', answer, settledAt: 200 });
    });

    it('pruneAsks 只剪已收尾的，pending 永不剪', () => {
        const store = openStore(':memory:');
        for (let index = 0; index < 4; index += 1) {
            store.putAsk({
                askId: `done-${index}`,
                entityId: room.id,
                at: index,
                request: askOf(`done-${index}`, index),
                state: 'answered',
                settledAt: index,
            });
        }
        store.putAsk({ askId: 'pending', entityId: room.id, at: 9, request: askOf('pending', 9), state: 'pending' });

        expect(store.pruneAsks(room.id, 2)).toBe(2);
        expect(store.asksOf(room.id).map((ask) => ask.askId)).toEqual(['done-2', 'done-3', 'pending']);
    });

    it('删房间连带清掉提问', () => {
        const store = openStore(':memory:');
        store.saveRoom(room);
        store.putAsk({ askId: 'ask-1', entityId: room.id, at: 1, request: askOf('ask-1', 1), state: 'pending' });
        store.deleteRoom(room.id);
        expect(store.asksOf(room.id)).toEqual([]);
    });
});

describe('撤掉中断事实（deleteInterruptedFacts）', () => {
    // 只撤「那一轮、那个 bot」的：turnId 是房间级的，@all 时两个 bot 共享一个 turnId
    it('按 turnId + botId 精确删，不误伤同轮的别人、也不误伤别的轮', () => {
        const store = openStore(':memory:');
        const notice = (idi: string, turnId: string, botId: string) =>
            store.appendItem(room.id, {
                id: idi,
                seq: 0,
                turnId,
                type: 'notice',
                at: 1,
                status: 'done',
                data: { text: '没跑完', kind: 'interrupted', botId },
            });
        notice('n-a3', 't3', 'bot:a');
        notice('n-b3', 't3', 'bot:b');
        notice('n-a4', 't4', 'bot:a');

        expect(store.deleteInterruptedFacts(room.id, 't3', 'bot:a')).toBe(1);
        const left = store.itemsOf(room.id).map((item) => item.id);
        expect(left.sort()).toEqual(['n-a4', 'n-b3']);
        // 幂等：撤第二次是 0 条
        expect(store.deleteInterruptedFacts(room.id, 't3', 'bot:a')).toBe(0);
    });
});

describe('分组查询走表达式索引', () => {
    // 守的是「别把索引删了、或改得对不上查询」：没有它们就是逐行 json_extract 全表扫，
    // 真实库 2.7 万行 / 118MB 实测 8.4s 与 3.5s；有索引是 25ms 与 54ms（见建表处的注释）。
    // 下面两条 SQL 是 db.ts 里 lastItemPerBot / lastFactPerTurn 的逐字副本 ——
    // 实现里的 SQL 改了这里要同步，否则断言会变成假绿。
    const LAST_ITEM_PER_BOT =
        "SELECT entity_id, MAX(seq) AS seq, item FROM entity_items WHERE json_extract(item, '$.author.id') IS NOT NULL GROUP BY entity_id, json_extract(item, '$.author.id')";
    const LAST_FACT_PER_TURN =
        "SELECT entity_id, COALESCE(json_extract(item, '$.data.botId'), json_extract(item, '$.turnId')) AS owner, MAX(seq) AS seq, item FROM entity_items WHERE json_extract(item, '$.author.id') IS NULL AND json_extract(item, '$.type') IN ('notice','error') GROUP BY entity_id, COALESCE(json_extract(item, '$.data.botId'), json_extract(item, '$.turnId'))";

    /** 查询计划里命中了哪条索引（全表扫的 detail 里不会出现索引名） */
    const planOf = (store: ReturnType<typeof openStore>, sql: string): string =>
        (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<Record<string, unknown>>)
            .map((row) => String(row['detail']))
            .join(' | ');

    it('lastItemPerBot 走 items_author_seq', () => {
        const store = openStore(':memory:');
        store.appendItem(room.id, {
            id: 'm1',
            seq: 0,
            turnId: 't1',
            type: 'chat',
            at: 1,
            status: 'done',
            author: { id: 'bot:1', name: 'b', color: '#000', role: 'bot' },
            data: { text: 'hi' },
        });
        expect(planOf(store, LAST_ITEM_PER_BOT)).toContain('items_author_seq');
    });

    const DELETE_INTERRUPTED =
        "DELETE FROM entity_items WHERE entity_id = ? AND json_extract(item, '$.data.kind') = 'interrupted' AND json_extract(item, '$.turnId') = ? AND json_extract(item, '$.data.botId') = ?";

    it('lastFactPerTurn 走 items_fact_owner_seq', () => {
        const store = openStore(':memory:');
        store.appendItem(room.id, {
            id: 'n1',
            seq: 0,
            turnId: 't1',
            type: 'notice',
            at: 1,
            status: 'done',
            data: { text: '没跑完', kind: 'interrupted', botId: 'bot:1' },
        });
        expect(planOf(store, LAST_FACT_PER_TURN)).toContain('items_fact_owner_seq');
    });

    // 两条调用点（重启时不报误报、续跑收尾时撤掉旧误报）都在启动 / 每轮收尾的路径上，
    // 全表扫 118MB 的 json 会让它们变成肉眼可见的卡顿；命中部分索引时表里只有个位数的行。
    it('deleteInterruptedFacts 走 items_interrupted', () => {
        const store = openStore(':memory:');
        store.appendItem(room.id, {
            id: 'n1',
            seq: 0,
            turnId: 't1',
            type: 'notice',
            at: 1,
            status: 'done',
            data: { text: '没跑完', kind: 'interrupted', botId: 'bot:1' },
        });
        expect(planOf(store, DELETE_INTERRUPTED)).toContain('items_interrupted');
    });
});
