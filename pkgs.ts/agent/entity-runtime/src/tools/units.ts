// tools/units.ts —— 任务「需求账本」的读写工具：让 agent 把任务**长成**两层（目标 → 可验收的需求）。
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
                '`ready` 是现在可以挑的需求。**每轮的 system 上下文里已经有全树**（units 节），' +
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
                '**账本只有两层：目标（顶层）→ 需求（挂在目标下）**，不再往下嵌。',
                '· `parent` 不填 = **目标**：一段独立、可以单独开始/完成/放弃的成果，可以没有子项。',
                '· `parent` 给一个**顶层条目** = **需求**：那个目标必须满足的一条可验收条件。',
                '· `parent` 指向非顶层条目会被拒 —— 需求下不再挂需求。',
                '',
                '**一条 unit = 一件能被验收的产出**：',
                '· 判据：做完之后能拿什么东西给人看（新行为 / 新接口 / 改好的数据 / 一份能引用的结论）。',
                '· 反例（**别进账本**）：读某文件、改某文件、跑测试、扫尾翻新、提 PR —— ' +
                    '那些是**执行步骤**，不进账本（决策写 journal，进度与输出留在工具记录里）。',
                '· 正例：「deleteRoom 事务化（中途失败不留半个删）」「unit 取消后下游不再引用它，且给得出原因」。',
                '',
                '粒度参考：一个目标下 2~7 条需求；再多就看看它们是不是其实是几个独立目标。',
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
                                .describe(
                                    '可选：所属**目标**的 key（同批任意项或树上已有的顶层 unit id）；不填 = 顶层目标',
                                ),
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
                    if (item.parent === item.key) throw new Error(`unit 不能挂到自己下面：${item.key}`);
                }
                // 两层的硬约束（2026-11-27 裁）：父只能是**顶层**。父可能在同一批里（先建后连），
                // 所以先把「本批每个 key 的父」整张表算出来再统一判深度 —— 不然 A 挂 B、B 挂 A
                // 这种同批循环也能过。
                const parentInBatch = new Map<string, string | null>();
                for (const item of items) parentInBatch.set(item.key, item.parent ?? null);
                for (const item of items) {
                    const parent = item.parent;
                    if (parent === undefined) continue;
                    const inBatch = batchKeys.has(parent);
                    const parentRecord = inBatch ? undefined : host.store.unitOf(host.taskId, parent);
                    if (!inBatch && parentRecord === undefined) {
                        throw new Error(
                            `parent 指向的 unit 不存在：${parent}（找不准 key 就先 unit_list 看现在的树，不要编）`,
                        );
                    }
                    const grandParent = inBatch
                        ? (parentInBatch.get(parent) ?? null)
                        : (host.store.unitOf(host.taskId, parent)?.parent ?? null);
                    if (grandParent !== null) {
                        throw new Error(
                            `账本只有两层（目标 → 需求）：${parent} 自己就挂在别的条目下，不能再当目标。` +
                                `如果 ${item.key} 确实是独立成果，就别给 parent（当顶层目标）；` +
                                `如果它只是 ${parent} 的一条条件，就把 parent 改成 ${parent} 所在的那个目标。`,
                        );
                    }
                }
                // 先全部建节点（带 parent）：这样 parent 可以引用同批任意项（含后面那些）
                for (const item of items) {
                    host.store.saveUnit({
                        taskId: host.taskId,
                        id: item.key,
                        allowNewId: true,
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
                // 全是平铺的顶层 = 没有拆过结构。可能真是几个独立目标，也可能只是没分 —— 提醒一句，不改它的树
                const flat = board.rows.length > 3 && board.groups.length === 0;
                // 软上限：一个目标下超过 7 条需求，就该看看它们是不是其实是几个独立目标
                // （不做成硬拦：硬拦会逼模型把不相干的需求硬塞进已有的几条里）
                const crowded = board.rows
                    .filter((row) => row.children.length > 7)
                    .map((row) => ({ id: row.id, title: row.title, count: row.children.length }));
                return {
                    ok: true,
                    added,
                    ready: board.ready,
                    ...(board.danglingParents.length === 0 ? {} : { danglingParents: board.danglingParents }),
                    ...(flat
                        ? {
                              warning:
                                  `现在这 ${String(board.rows.length)} 条都是平铺的顶层（没有目标把需求归到一起）—— ` +
                                  '如果它们其实分属几个目标，用 unit_update 的 parent 挂上去（或下次 unit_add 时给 parent）。',
                          }
                        : {}),
                    ...(crowded.length === 0
                        ? {}
                        : {
                              hint:
                                  `${crowded.map((row) => `${row.id}（${String(row.count)} 条）`).join('、')} 下面挂得太满 —— ` +
                                  '一个目标下超过 7 条需求，通常说明这其实是几个独立目标：把其中成块的提到顶层，而不是继续往里塞。',
                          }),
                };
            },
        }),

        unit_update: tool({
            description:
                '改一条 unit：title / body / parent，或推状态（doing=开始做、done=做完、open=退回去重做）。' +
                '**只有叶子能推状态**：目标（有子）的状态由子派生，改它会被拒。' +
                '**换挂点只能挂到顶层**（账本只有两层）；有子的条目不能再往上挂。' +
                '未知字段不要瞎猜，先 unit_get 看它现在是什么。',
            inputSchema: z.object({
                id: z.string(),
                title: z.string().min(1).optional(),
                body: z
                    .string()
                    .optional()
                    .describe('这条需求要解决什么（背景 / 范围）—— 进展不要写这里（进展用 journal）'),
                accept: z.string().optional().describe('怎么算做完：一句话能判断完/未完的判据'),
                parent: z.string().nullable().optional().describe('换挂点：给**目标**（顶层条目）的 key；传 null = 提到顶层'),
                status: z.enum(UNIT_STATUSES).optional().describe('open / doing / done（只有叶子能改）'),
            }),
            execute: async ({ id, title, body, accept, parent, status }) => {
                const current = need(host, id);
                const board = boardOf(host);
                const row = board.rows.find((item) => item.id === id);
                if (status !== undefined) {
                    if (row?.group === true) {
                        throw new Error(
                            `${id} 是目标（有 ${String(row.children.length)} 个需求）：它的状态由需求派生，不能直接改。` +
                                '要推进就改它下面的需求。',
                        );
                    }
                }
                if (parent !== undefined && parent !== null) {
                    if (parent === id) throw new Error(`unit 不能挂到自己下面：${id}`);
                    if ((row?.children.length ?? 0) > 0) {
                        throw new Error(
                            `${id} 下面已经挂着需求，不能再挂到别人下面（账本只有两层）。` +
                                '要合并目标就把需求用 unit_update 的 parent 搬过去。',
                        );
                    }
                    const target = host.store.unitOf(host.taskId, parent);
                    if (target === undefined) throw new Error(`parent 指向的 unit 不存在：${parent}`);
                    if ((target.parent ?? null) !== null) {
                        throw new Error(
                            `账本只有两层：${parent} 自己就挂在 ${String(target.parent)} 下，不能当目标。` +
                                '要挂在同一个目标下，就把 parent 改成那个顶层条目。',
                        );
                    }
                }
                const next = host.store.saveUnit({
                    taskId: host.taskId,
                    id,
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
                '删目标时，它下面的需求会**提升到它原来的位置**（不连带删除 —— 它们是真活着的工作）。' +
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
                '看一条 unit 的全文（title / body / accept / source / 状态 / 子项）。' +
                '`accept` = 怎么算做完（空串 = 还没写，该补）；`source` = 这条需求来自哪句人话；' +
                '`children` = 挂在它下面的需求（只有目标会有）。',
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
