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
            description:
                '往任务里加一批工作单元（原子步）。`deps` = 这些做完才能做新的（DAG 的边）：' +
                '可以写已有的 unit id（u3），也可以写同一批里**前面**某项的 key。' +
                '一次能加几条就加几条（生长式规划）；title 写成一句可执行的话，body 写验收口径。',
            inputSchema: z.object({
                items: z
                    .array(
                        z.object({
                            key: z
                                .string()
                                .optional()
                                .describe('本批内的别名：后面的项可以在 deps 里用它引用这一项'),
                            title: z.string().min(1).describe('一步做什么（一句话，可执行）'),
                            body: z.string().optional().describe('可选：验收口径 / 注意点'),
                            deps: z
                                .array(z.string())
                                .optional()
                                .describe('前置：已有的 unit id，或本批前面的 key'),
                        }),
                    )
                    .min(1),
            }),
            execute: async ({ items }) => {
                // 批内 key → 新 id。只能引用**前面**的项：id 由 store 分配，后面的项此刻还没有 id，
                // 而「先建完全部再连边」得自己造一套回滚 —— 顺序解引是最小且真实的形状。
                const keys = new Map<string, string>();
                const added: Array<{ id: string; title: string }> = [];
                for (const [index, item] of items.entries()) {
                    if (item.key !== undefined && keys.has(item.key)) {
                        throw new Error(`同批 key 重复：${item.key}`);
                    }
                    const resolved: string[] = [];
                    for (const dep of item.deps ?? []) {
                        const inline = keys.get(dep);
                        if (inline !== undefined) {
                            resolved.push(inline);
                            continue;
                        }
                        // 指向本批后面的 key：明确拒绝，而不是模糊地报「unit 不存在」让人猜
                        if (items.slice(index + 1).some((other) => other.key === dep)) {
                            throw new Error(`deps 只能引用同批**前面**的项：${dep}（后面的项还没有 id）`);
                        }
                        need(host, dep);
                        resolved.push(dep);
                    }
                    const unit = host.store.saveUnit({
                        taskId: host.taskId,
                        title: item.title,
                        body: item.body ?? '',
                        status: 'open',
                    });
                    for (const dep of resolved) host.store.linkUnits(host.taskId, dep, unit.id);
                    if (item.key !== undefined) keys.set(item.key, unit.id);
                    emit(host, EVENT.added, { id: unit.id, title: unit.title, deps: resolved });
                    added.push({ id: unit.id, title: unit.title });
                }
                const board = boardOf(host);
                return { ok: true, added, ready: board.ready };
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
            description: '加一条依赖：`from` 先做完，`to` 才能做。会成环的请求会被拒（图必须是无环的）。',
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
