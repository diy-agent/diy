// tools/units.ts —— 任务「需求账本树」的读写工具：让 agent 把任务**长成**一棵树（母项 → 可验收的产出）。
//
// 2026-11-25 用户裁：账本只记「要做什么」，**不记执行规划**。所以这里只剩两类操作 ——
// 往树上加/改/删条目。曾经有 `unit_link` / `unit_unlink`（依赖边）、`batch_*`（交付批次）、
// 「同父兄弟串行」：那些是「怎么排期」，写进账本要人提前排一遍、排完还得维护，而模型每个
// 回合本来就会自己挑几条做（看 `ready` 就行）。删掉之后工具面从 12 个降到 6 个。
//
// 与 journal 的分工（用户 2026-11-24 裁）：unit 变更**走 events**（`task.unit.*`），
// 不走 journal —— journal 的最近 24 条要进 system 上下文，unit 变更频率高，塞进去会把
// 真决策挤出去。取消 = 真删，但删除前把 title / reason 记进事件，所以「这步为什么没了」答得出。

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { UNIT_STATUSES, type Store, type UnitRecord } from '../db';
import { unitBoard, unitTreeLines, type UnitBoard } from '../units';
import { toolReminder, type RemindMode } from '../units-remind';

/** 工具写入落点：只认 store + 一个 taskId（unit 是 task 私有的，id 只在该 task 内唯一） */
export interface UnitHost {
    store: Store;
    /** 这个房间对应的任务 id；unit 都挂它 */
    taskId: string;
    /**
     * C 档提醒（`units-remind.ts`）：把「这句话里如果有新需求就先落一条」写进 `unit_add`
     * 的描述。不传 = 不提醒（实验里的 `off` / `a` / `b` 档）。
     */
    remind?: RemindMode;
    /**
     * 这条需求来自哪句人话（**宿主盖章**）。模型根本看不到 message id，让它填只会编错 ——
     * 所以由房间在「本轮触发消息」上取，`unit_add` 落库时自动带上。
     */
    sourceOf?: () => string | undefined;
}

/** 事件名（`<type>.<verb>`，与 `task.journal` 同一套命名） */
const EVENT = {
    added: 'task.unit.added',
    updated: 'task.unit.updated',
    dropped: 'task.unit.dropped',
} as const;

/** 历史查询的前缀 = `task.`（unit 与 journal 同一条时间线） */
const EVENT_PREFIX = 'task.';

/**
 * key 的合法形状：小写字母开头，小写英文 / 数字 / `-` / `_`。
 *
 * 它不只是别名 —— **key 就是 unit 的 id**（见 `unit_add` 注释）。限定字符集是为了让 id 进得了
 * 事件、URL、聊天引用，也不必为「模型随手起中文 key」再写一套转义。
 */
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

/**
 * 给模型看的账本：**缩进树 + 现在能挑的**。
 *
 * 树行里已带状态，所以不再另给一份分层 JSON —— 那是同一份事实的第二份。
 * `ready` / `doing` 还点名一次：那是行动指令，值得重复。
 */
function briefBoard(host: UnitHost) {
    const board = boardOf(host);
    const titleOf = (id: string): string => board.rows.find((row) => row.id === id)?.title ?? '';
    return {
        ready: board.ready.map((id) => ({ id, title: titleOf(id) })),
        doing: board.doing.map((id) => ({ id, title: titleOf(id) })),
        counts: {
            open: board.rows.filter((row) => row.status === 'open').length,
            doing: board.rows.filter((row) => row.status === 'doing').length,
            done: board.done.length,
        },
        tree: unitTreeLines(board),
        ...(board.danglingParents.length === 0 ? {} : { danglingParents: board.danglingParents }),
    };
}

function boardOf(host: UnitHost): UnitBoard {
    return unitBoard(host.store.listUnits(host.taskId));
}

function need(host: UnitHost, id: string): UnitRecord {
    const unit = host.store.unitOf(host.taskId, id);
    if (unit === undefined) throw new Error(`unit 不存在：${id}（先 unit_list 看现在的树）`);
    return unit;
}

function emit(host: UnitHost, event: string, data: unknown): void {
    host.store.appendEvent({ event, subject: host.taskId, data });
}

/**
 * 六个工具。返回给模型的都只是**确认 + 变化**，不回整棵树 ——
 * 下一模型步的 system 上下文里已经有全量树（`unitsProvider`），重复只会多花 token 且制造第二份真源。
 */
export function unitTools(host: UnitHost): ToolSet {
    return {
        unit_list: tool({
            description:
                '看这张需求账本树的当前状态：`tree` 是缩进树（`x`=做完 / `>`=现在能挑 / `~`=在做），' +
                '`ready` 是现在可以挑的叶子。**每轮的 system 上下文里已经有全树**（units 节），' +
                '所以只在「要拿准某个 id / 想知道某条 body」时才调它，不必先查再动手。',
            inputSchema: z.object({}),
            execute: async () => briefBoard(host),
        }),

        unit_add: tool({
            description: [
                ...(toolReminder(host.remind ?? { prompt: false, envelope: false, tool: false }) === ''
                    ? []
                    : [toolReminder(host.remind as RemindMode)]),
                '往账本树上加条目：**一次调用 = 一批**（整棵树一次给全最好）。',
                '**接到需求、或需求变了的时候，这是第一步** —— 先把「要做成哪些东西」写下来，再动手。',
                '',
                '· `parent` 是**母项**：这块需求由哪些子块组成。不填 = 顶层。',
                '',
                '**一条 unit = 一件能被验收的产出**（叶子）或**一个母项**（有子、本身不执行）：',
                '· 叶子判据：做完之后能拿什么东西给人看（新行为 / 新接口 / 改好的数据 / 一份能引用的结论）。',
                '· 反例（**别进需求层**）：读某文件、改某文件、跑测试、全量质检、扫尾翻新 —— ' +
                    '那些是**步骤**，用 `kind: "step"` + `parent` 挂在对应需求下面（只有三档状态，不写 accept）。',
                '· 正例：「deleteRoom 事务化（中途失败不留半个删）」「unit 取消后下游不再引用它，且给得出原因」。',
                '',
                '粒度参考：一个母项下 2~5 条叶子；超过 7 条说明该再分一层。',
                '`key` 必填：**它就是这条 unit 的 id**，也是以后 parent 引用它的名字 —— ' +
                    '起短名（`state`、`cancel-tool`，小写英文 / 数字 / - _，≤24）。同批任意项的 key 都能引用（在它后面也行）。',
                'body 写验收口径。',
                '',
                '**不要**在这里排先后、写批次：账本只回答「要做成哪些东西」，先做哪个由你每轮自己挑。',
            ].join('\n'),
            inputSchema: z.object({
                items: z
                    .array(
                        z.object({
                            key: z
                                .string()
                                .regex(KEY_PATTERN, 'key 只能是小写字母开头的小写英文 / 数字 / - _，≤24 字符')
                                .describe(
                                    '这条 unit 的 id（自起的短名，如 state / cancel-tool）；后面的项与以后的操作都用它引用',
                                ),
                            kind: z
                                .enum(['need', 'step'])
                                .optional()
                                .describe(
                                    'need（缺省）= 要做什么，人要能验收、进需求树；' +
                                        'step = 怎么做，挂在某条需求下面的一步（不写 accept、不进需求层，只在点开那条需求时出现）',
                                ),
                            title: z
                                .string()
                                .min(1)
                                .describe('一件能被验收的产出（不是动作：写「什么改好了」，不是「改哪个文件」）'),
                            body: z
                                .string()
                                .optional()
                                .describe(
                                    '可选：这条需求要解决什么（背景 / 范围 / 注意点）——**验收口径不写这里**，写 accept',
                                ),
                            accept: z
                                .string()
                                .optional()
                                .describe(
                                    '怎么算做完：一句话能判断完/未完的判据（如「点导出真的落文件，且首末轮都在」）。' +
                                        '**尽量写**：没写的人一眼看得见，会回来问你',
                                ),
                            parent: z
                                .string()
                                .optional()
                                .describe('可选：母项的 key（同批任意项或树上已有的 unit id）；不填 = 顶层'),
                        }),
                    )
                    .min(1),
            }),
            execute: async ({ items }) => {
                // 先校验整批再动库：半截写入比直接报错更难收拾
                const batchKeys = new Set<string>();
                for (const item of items) {
                    if (!KEY_PATTERN.test(item.key)) {
                        throw new Error(`key 只能用 小写字母开头的小写英文 / 数字 / - _（≤24 字符）：${item.key}`);
                    }
                    if (batchKeys.has(item.key)) throw new Error(`同批 key 重复：${item.key}`);
                    batchKeys.add(item.key);
                    const taken = host.store.unitOf(host.taskId, item.key);
                    if (taken !== undefined) {
                        throw new Error(`key 已被占用：${item.key}（已在树上，用 unit_update 改它，或换个 key）`);
                    }
                    if (item.parent === item.key) throw new Error(`unit 不能是自己的母项：${item.key}`);
                    // 步骤必须挂在某条需求下：没父的 step 在界面上没有归属（会被当垃圾数据丢掉）
                    if (item.kind === 'step' && item.parent === undefined) {
                        throw new Error(`步骤要挂在一条需求下面：${item.key} 缺 parent`);
                    }
                }
                // 先全部建节点（带 parent）：这样 parent 可以引用同批任意项（含后面那些）
                for (const item of items) {
                    host.store.saveUnit({
                        taskId: host.taskId,
                        id: item.key,
                        allowNewId: true,
                        kind: item.kind ?? 'need',
                        title: item.title,
                        body: item.body ?? '',
                        accept: item.accept ?? '',
                        // 来源自动盖章：只认宿主给的「本轮触发消息」，模型填不了也没必要填
                        ...(host.sourceOf?.() === undefined ? {} : { source: host.sourceOf() }),
                        status: 'open',
                        parent: item.parent ?? null,
                    });
                }
                const added: Array<{ id: string; title: string; parent: string | null }> = [];
                for (const item of items) {
                    emit(host, EVENT.added, {
                        id: item.key,
                        title: item.title,
                        parent: item.parent ?? null,
                    });
                    added.push({ id: item.key, title: item.title, parent: item.parent ?? null });
                }
                const board = boardOf(host);
                // 全是平铺的顶层 = 没有拆过结构。可能是真有多个母项，也可能只是没分 —— 提醒一句，不改它的树
                const flat = board.rows.length > 3 && board.groups.length === 0;
                return {
                    ok: true,
                    added,
                    ready: board.ready,
                    ...(board.danglingParents.length === 0 ? {} : { danglingParents: board.danglingParents }),
                    ...(flat
                        ? {
                              warning:
                                  `现在这 ${board.rows.length} 条都是平铺的顶层（没有母项）。` +
                                  '如果它们其实分属几块需求，用 unit_update 的 parent 挂上去（或下次 unit_add 时给 parent）。',
                          }
                        : {}),
                };
            },
        }),

        unit_update: tool({
            description:
                '改一条 unit：title / body / parent，或推状态（doing=开始做、done=做完、open=退回去重做）。' +
                '**只有叶子能推状态**：母项（有子）的状态由子派生，改它会被拒。' +
                '未知字段不要瞎猜，先 unit_get 看它现在是什么。',
            inputSchema: z.object({
                id: z.string(),
                kind: z.enum(['need', 'step']).optional().describe('改成步骤 / 改回需求（一般不用动）'),
                title: z.string().min(1).optional(),
                body: z
                    .string()
                    .optional()
                    .describe('这条需求要解决什么（背景 / 范围）—— 进展不要写这里（进展用 journal）'),
                accept: z.string().optional().describe('怎么算做完：一句话能判断完/未完的判据'),
                parent: z.string().nullable().optional().describe('换挂点：给母项的 key；传 null = 提到顶层'),
                status: z.enum(UNIT_STATUSES).optional().describe('open / doing / done（只有叶子能改）'),
            }),
            execute: async ({ id, kind, title, body, accept, parent, status }) => {
                const current = need(host, id);
                if (status !== undefined) {
                    const row = boardOf(host).rows.find((item) => item.id === id);
                    if (row?.group === true) {
                        throw new Error(
                            `${id} 是母项（有 ${row.children.length} 个子）：它的状态由子派生，不能直接改。` +
                                '要推进就改它下面的叶子。',
                        );
                    }
                }
                if (parent !== undefined && parent !== null) {
                    if (parent === id) throw new Error(`unit 不能挂到自己下面：${id}`);
                    // 父链成环：往上走一遍，碰见自己就拒
                    let cursor: string | null = parent;
                    const guard = new Set<string>([id]);
                    while (cursor !== null) {
                        if (guard.has(cursor)) throw new Error(`父链会成环：${id} → ${parent} → …`);
                        guard.add(cursor);
                        cursor = host.store.unitOf(host.taskId, cursor)?.parent ?? null;
                    }
                }
                const next = host.store.saveUnit({
                    taskId: host.taskId,
                    id,
                    kind: kind ?? current.kind,
                    title: title ?? current.title,
                    body: body ?? current.body,
                    accept: accept ?? current.accept,
                    status: status ?? current.status,
                    ...(parent === undefined ? {} : { parent }),
                });
                const fields = {
                    ...(title === undefined ? {} : { title }),
                    ...(body === undefined ? {} : { body }),
                    ...(accept === undefined ? {} : { accept }),
                    ...(parent === undefined ? {} : { parent }),
                    ...(status === undefined ? {} : { status }),
                };
                emit(host, EVENT.updated, { id, fields });
                return { ok: true, id, status: next.status, ready: boardOf(host).ready };
            },
        }),

        unit_drop: tool({
            description:
                '取消一条 unit：**从树上真删掉**。' +
                '删母项时，它下面的子会**提升到它原来的位置**（不连带删除 —— 子是真活着的工作）。' +
                '必须给 reason —— 事件里会留下 title + reason，所以「这条为什么没了」以后还查得到。',
            inputSchema: z.object({
                id: z.string(),
                reason: z.string().min(1).describe('为什么取消（一句话，给未来的自己看）'),
            }),
            execute: async ({ id, reason }) => {
                const current = need(host, id);
                const children = host.store
                    .listUnits(host.taskId)
                    .filter((unit) => unit.parent === id)
                    .map((unit) => unit.id);
                for (const child of children) {
                    const record = host.store.unitOf(host.taskId, child)!;
                    host.store.saveUnit({
                        taskId: host.taskId,
                        id: child,
                        title: record.title,
                        body: record.body,
                        accept: record.accept,
                        status: record.status,
                        parent: current.parent,
                    });
                }
                host.store.removeUnit(host.taskId, id);
                emit(host, EVENT.dropped, { id, title: current.title, reason, promoted: children });
                return {
                    ok: true,
                    dropped: id,
                    ...(children.length === 0 ? {} : { promoted: children }),
                    ready: boardOf(host).ready,
                };
            },
        }),

        unit_get: tool({
            description:
                '看一条 unit 的全文（title / body / accept / source / 状态 / 步骤与进度）。' +
                '`accept` = 怎么算做完（空串 = 还没写，该补）；`source` = 这条需求来自哪句人话；' +
                '`steps` = 挂在它下面的步骤（`kind: "step"`）与进度。',
            inputSchema: z.object({ id: z.string() }),
            execute: async ({ id }) => {
                const unit = need(host, id);
                const row = boardOf(host).rows.find((item) => item.id === id);
                return {
                    id: unit.id,
                    title: unit.title,
                    body: unit.body,
                    accept: unit.accept,
                    // 来源由宿主盖章（模型看不到 message id，不该由它填）
                    source: unit.source,
                    status: row?.status ?? unit.status,
                    parent: row?.parent ?? null,
                    children: row?.children ?? [],
                    // 挂在它下面的步骤与进度（步骤不进需求层，但要能查：做到这条需求时看自己走到哪）
                    steps: (row?.steps ?? []).map((step) => ({ id: step.id, title: step.title, status: step.status })),
                    progress: row?.progress ?? { done: 0, total: 0 },
                };
            },
        }),

        // 历史不在界面上看，但要能查：unit_drop 之后「它曾经是什么、为什么被取消」
        unit_history: tool({
            description: '查这棵账本树的历史事件（新增 / 改动 / 删除 + 原因），新→旧。',
            inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
            execute: async ({ limit }) => {
                const events = host.store.eventsOf(host.taskId, EVENT_PREFIX, limit ?? 30);
                return {
                    events: events.map((event) => ({
                        at: event.at,
                        event: event.event.slice(EVENT_PREFIX.length),
                        data: event.data,
                    })),
                };
            },
        }),
    };
}
