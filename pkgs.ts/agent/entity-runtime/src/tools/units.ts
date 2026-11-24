// tools/units.ts —— 任务内部 DAG（unit）的读写工具：让 agent 在聊天里把任务**长成**一张图。
//
// 为什么不是「在正文里列 TODO」：正文是一整块文本，勾掉一行不改变任何机器可读的事实，
// 也就没人能回答「现在能做哪些 / 为什么这条卡着」。unit 是两份最小事实（节点 + 依赖边），
// 其余（ready / blocked / 层）全是算出来的（见 `../units.ts`）。
//
// 与 journal 的分工（用户 2026-11-24 裁）：unit 变更**走 events**（`task.unit.*`），
// 不走 journal —— journal 的最近 24 条要进 system 上下文，unit 变更频率高，塞进去会把
// 真决策挤出去。取消 = 真删，但删除前把 title / reason 记进事件，所以「这步为什么没了」答得出。

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { UNIT_STATUSES, type Store, type UnitRecord } from '../db';
import { unitBoard, type UnitBoard } from '../units';

/** 工具写入落点：只认 store + 一个 taskId（unit 是 task 私有的，id 只在该 task 内唯一） */
export interface UnitHost {
    store: Store;
    /** 这个房间对应的任务 id；unit 都挂它 */
    taskId: string;
}

/** 事件名（`<type>.<verb>`，与 `task.journal` 同一套命名） */
const EVENT = {
    added: 'task.unit.added',
    updated: 'task.unit.updated',
    linked: 'task.unit.linked',
    unlinked: 'task.unit.unlinked',
    dropped: 'task.unit.dropped',
} as const;

const EVENT_PREFIX = 'task.unit.';

/**
 * key 的合法形状：小写字母开头，小写英文 / 数字 / `-` / `_`。
 *
 * 它不只是别名 —— **key 就是 unit 的 id**（见 `unit_add` 注释）。限定字符集是为了让 id 进得了
 * 事件、URL、聊天引用，也不必为「模型随手起中文 key」再写一套转义。
 */
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

/** 给模型看的 board：省掉 body（可能很长）与 seq（内部排序） */
function briefBoard(board: UnitBoard) {
    return {
        ready: board.ready,
        doing: board.doing,
        blocked: board.blocked,
        done: board.done,
        layers: board.layers.map((layer) =>
            layer.map((row) => ({ id: row.id, title: row.title, status: row.status, deps: row.deps })),
        ),
        ...(board.cyclic ? { cyclic: true } : {}),
    };
}

function boardOf(host: UnitHost): UnitBoard {
    return unitBoard(host.store.listUnits(host.taskId), host.store.unitDepsOf(host.taskId));
}

function need(host: UnitHost, id: string): UnitRecord {
    const unit = host.store.unitOf(host.taskId, id);
    if (unit === undefined) throw new Error(`unit 不存在：${id}（先 unit_list 看现在的图）`);
    return unit;
}

function emit(host: UnitHost, event: string, data: unknown): void {
    host.store.appendEvent({ event, subject: host.taskId, data });
}

/**
 * 七个工具。返回给模型的都只是**确认 + 变化**，不回整张图 ——
 * 下一模型步的 system 上下文里已经有全量 DAG（`unitsProvider`），重复只会多花 token 且制造第二份真源。
 */
export function unitTools(host: UnitHost): ToolSet {
    return {
        unit_list: tool({
            description:
                '看这张任务分解图（unit DAG）的当前状态：ready=现在能做的（前置都做完了）/ doing / blocked / done，' +
                '并按依赖分层。要改图之前先看它，拿准 id。',
            inputSchema: z.object({}),
            execute: async () => briefBoard(boardOf(host)),
        }),

        unit_add: tool({
            description: [
                '往任务里加一批工作单元。**一次调用 = 一批**：整张图一次给全最好（生长式规划时也只给这一批）。',
                '**一条 unit = 一件能被验收的产出**，不是一次动作 —— ',
                '判据：做完之后能拿什么东西给人看（新行为 / 新接口 / 改好的数据 / 一份能引用的结论）。',
                '反例（**别进图**）：读某文件、改某文件、跑测试、全量质检、扫尾翻新 —— 那些是执行步骤，自己排就行。',
                '正例：「deleteRoom 事务化（中途失败不留半个删）」「unit 取消后下游进 blocked，且给得出被谁挡」。',
                '',
                '`key` 必填：**它就是这条 unit 的 id**，也是以后 deps / unit_update / unit_link 引用它的名字。',
                '起短名：`state`、`cancel-tool`、`board`（小写英文 / 数字 / - _，≤24 字符）。',
                '`deps` 是 DAG 的边：写前置的 key —— **必须写进 deps**，写进 title / body 等于没连边。',
                '同批里**任意项**的 key 都能引用（在它后面也可以）；端点还没落库的边会先挂着，等它出现自动生效。',
                'body 写验收口径。',
            ].join('\n'),
            inputSchema: z.object({
                items: z
                    .array(
                        z.object({
                            key: z
                                .string()
                                .regex(KEY_PATTERN, 'key 只能是小写字母开头的小写英文 / 数字 / - _，≤24 字符')
                                .describe('这条 unit 的 id（自起的短名，如 state / cancel-tool）；后面的项与以后的操作都用它引用'),
                            title: z.string().min(1).describe('一件能被验收的产出（不是动作：写「什么改好了」，不是「改哪个文件」）'),
                            body: z.string().optional().describe('可选：验收口径 / 注意点'),
                            deps: z
                                .array(z.string())
                                .optional()
                                .describe('前置：写它们的 key（同批任意项、或图上已有的 unit id）'),
                        }),
                    )
                    .min(1),
            }),
            execute: async ({ items }) => {
                // 先校验整批再动库：半截写入比直接报错更难收拾
                const batchKeys = new Set<string>();
                for (const item of items) {
                    if (!KEY_PATTERN.test(item.key)) {
                        throw new Error(
                            `key 只能用 小写字母开头的小写英文 / 数字 / - _（≤24 字符）：${item.key}`,
                        );
                    }
                    if (batchKeys.has(item.key)) throw new Error(`同批 key 重复：${item.key}`);
                    batchKeys.add(item.key);
                    const taken = host.store.unitOf(host.taskId, item.key);
                    if (taken !== undefined) {
                        throw new Error(`key 已被占用：${item.key}（已在图里，用 unit_update 改它，或换个 key）`);
                    }
                    if ((item.deps ?? []).includes(item.key)) throw new Error(`unit 不能依赖自己：${item.key}`);
                }
                // 两轮：**先全部建节点，再连边** —— 这样 deps 可以引用同批任意项（含后面那些），
                // 而端点没到位的边由 allowMissing 挂起（并行调用也能接上）。
                for (const item of items) {
                    host.store.saveUnit({
                        taskId: host.taskId,
                        id: item.key,
                        allowNewId: true,
                        title: item.title,
                        body: item.body ?? '',
                        status: 'open',
                    });
                }
                const added: Array<{ id: string; title: string; deps: string[] }> = [];
                for (const item of items) {
                    const deps = [...new Set(item.deps ?? [])];
                    for (const dep of deps) {
                        host.store.linkUnits(host.taskId, dep, item.key, { allowMissing: true });
                    }
                    emit(host, EVENT.added, { id: item.key, title: item.title, deps });
                    added.push({ id: item.key, title: item.title, deps });
                }
                const board = boardOf(host);
                const known = new Set(host.store.listUnits(host.taskId).map((unit) => unit.id));
                const edges = host.store.unitDepsOf(host.taskId);
                const dangling = [
                    ...new Set(
                        edges.flatMap((edge) => [
                            ...(known.has(edge.from) ? [] : [edge.from]),
                            ...(known.has(edge.to) ? [] : [edge.to]),
                        ]),
                    ),
                ];
                const flat = board.rows.length > 1 && board.rows.every((row) => row.deps.length === 0);
                return {
                    ok: true,
                    added,
                    ready: board.ready,
                    ...(dangling.length === 0 ? {} : { dangling }),
                    ...(flat
                        ? {
                              warning:
                                  `这张图现在是 ${board.rows.length} 个孤立点（彼此没有任何依赖）。` +
                                  '如果这些事之间其实有先后，用 unit_link 连上（from 先做完 → to 才能做）。',
                          }
                        : {}),
                };
            },
        }),

        unit_update: tool({
            description:
                '改一条 unit：title / body，或推状态（doing=开始做、done=做完、open=退回去重做）。' +
                '未知字段不要瞎猜，先 unit_get 看它现在是什么。',
            inputSchema: z.object({
                id: z.string(),
                title: z.string().min(1).optional(),
                body: z.string().optional(),
                status: z.enum(UNIT_STATUSES).optional().describe('open / doing / done'),
            }),
            execute: async ({ id, title, body, status }) => {
                const current = need(host, id);
                const next = host.store.saveUnit({
                    taskId: host.taskId,
                    id,
                    title: title ?? current.title,
                    body: body ?? current.body,
                    status: status ?? current.status,
                });
                const fields = {
                    ...(title === undefined ? {} : { title }),
                    ...(body === undefined ? {} : { body }),
                    ...(status === undefined ? {} : { status }),
                };
                emit(host, EVENT.updated, { id, fields });
                const board = boardOf(host);
                return { ok: true, id, status: next.status, ready: board.ready };
            },
        }),

        unit_link: tool({
            description:
                '补一条依赖：`from` 先做完，`to` 才能做。两端都得已经在图上（用它们的 key）。' +
                '会成环的请求会被拒（图必须是无环的）。',
            inputSchema: z.object({ from: z.string(), to: z.string() }),
            execute: async ({ from, to }) => {
                need(host, from);
                need(host, to);
                host.store.linkUnits(host.taskId, from, to);
                emit(host, EVENT.linked, { from, to });
                return { ok: true, ready: boardOf(host).ready };
            },
        }),

        unit_unlink: tool({
            description: '删一条依赖（`from` 不再挡 `to`）。幂等：本来就没有也不报错。',
            inputSchema: z.object({ from: z.string(), to: z.string() }),
            execute: async ({ from, to }) => {
                const removed = host.store.unlinkUnits(host.taskId, from, to);
                if (removed) emit(host, EVENT.unlinked, { from, to });
                return { ok: true, removed, ready: boardOf(host).ready };
            },
        }),

        unit_drop: tool({
            description:
                '取消一条 unit：**从图上真删掉**（它的依赖边一起删，被它挡住的 unit 可能立刻变成可做）。' +
                '必须给 reason —— 事件里会留下 title + reason，所以「这步为什么没了」以后还查得到。',
            inputSchema: z.object({
                id: z.string(),
                reason: z.string().min(1).describe('为什么取消（一句话，给未来的自己看）'),
            }),
            execute: async ({ id, reason }) => {
                const current = need(host, id);
                host.store.removeUnit(host.taskId, id);
                emit(host, EVENT.dropped, { id, title: current.title, reason });
                return { ok: true, dropped: id, ready: boardOf(host).ready };
            },
        }),

        unit_get: tool({
            description: '看一条 unit 的全文（title / body / 前置 / 后继 / 状态）。',
            inputSchema: z.object({ id: z.string() }),
            execute: async ({ id }) => {
                const unit = need(host, id);
                const board = boardOf(host);
                const row = board.rows.find((item) => item.id === id);
                return {
                    id: unit.id,
                    title: unit.title,
                    body: unit.body,
                    status: unit.status,
                    deps: row?.deps ?? [],
                    dependents: row?.dependents ?? [],
                    layer: row?.layer ?? 0,
                };
            },
        }),

        // 历史不在界面上看，但要能查：unit_drop 之后「它曾经是什么、为什么被取消」
        unit_history: tool({
            description: '查这张图的历史事件（新增 / 改动 / 连边 / 删除 + 原因），新→旧。',
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
