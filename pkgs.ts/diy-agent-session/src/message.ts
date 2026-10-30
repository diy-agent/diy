// message.ts — 消息与增量的解析 / 自检
//
// 消息形状 = 设计定稿 `session-design.md` §二的 Entry（多一个给 LLM 看的 `role`）：
//   { seq, at, type, text?, mentions?, data? , role }
//
// 判别联合按 diy 规范（rule.code#discriminated-union）：判别键 `type`、同级 = 公共字段、
// 分支私有载荷进 `data`（tool-call ⇒ `data.tool`）。`data` 是**能力槽位**：本包只校验
// 「装得下」（可 JSON 序列化，能落盘 / 能跨进程），不解释里面的 schema。
//
// 两条铁律：
//   ① 消息形状不对 ⇒ `session/invalid-message`（带点路径）；
//   ② LlmPort 吐出别的东西 ⇒ `session/invalid-delta`——适配器写错了要立刻炸在边界上，
//      不能让半条内容流进历史。

import { SessionError } from './errors.js';
import type { ChatMessage, ChatToolCall, MessageRole, MessageType, SessionDelta } from './types.js';
import { rejectUnknown, takeNonNegativeInteger, takeNonNegativeNumber, takeObject, takeString } from './validate.js';

export const MESSAGE_ROLES: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool'];

export const MESSAGE_TYPES: readonly MessageType[] = [
    'human',
    'agent-conclusion',
    'agent-notice',
    'agent-trace',
    'tool-call',
    'tool-result',
];

/** 缺省 type 推导：user 是人说的话，assistant 默认是本轮结论，tool 是工具结果；system 无分类 */
const DEFAULT_TYPE: Partial<Record<MessageRole, MessageType>> = {
    user: 'human',
    assistant: 'agent-conclusion',
    tool: 'tool-result',
};

const MESSAGE_KEYS = ['seq', 'role', 'type', 'text', 'mentions', 'at', 'data'] as const;
const TOOL_KEYS = ['name', 'args', 'id'] as const;

/** 解析一条消息（非法即抛 `session/invalid-message`） */
export function parseMessage(value: unknown, path = 'message'): ChatMessage {
    const obj = takeObject(value, path, 'session/invalid-message');
    rejectUnknown(obj, MESSAGE_KEYS, path, 'session/invalid-message');

    const role = takeString(obj.role, `${path}.role`, 'session/invalid-message');
    if (!MESSAGE_ROLES.includes(role as MessageRole)) {
        throw new SessionError(
            'session/invalid-message',
            `未知角色 ${role}（允许：${MESSAGE_ROLES.join(' / ')}）`,
            `${path}.role`,
        );
    }

    const rawType = obj.type === undefined ? DEFAULT_TYPE[role as MessageRole] : obj.type;
    if (rawType !== undefined && !MESSAGE_TYPES.includes(rawType as MessageType)) {
        throw new SessionError(
            'session/invalid-message',
            `未知消息分类 ${String(rawType)}（允许：${MESSAGE_TYPES.join(' / ')}）`,
            `${path}.type`,
        );
    }

    const seq =
        obj.seq === undefined ? undefined : takeNonNegativeInteger(obj.seq, `${path}.seq`, 'session/invalid-message');
    const at =
        obj.at === undefined ? undefined : takeNonNegativeNumber(obj.at, `${path}.at`, 'session/invalid-message');
    const text = obj.text === undefined ? undefined : takeString(obj.text, `${path}.text`, 'session/invalid-message');
    const mentions =
        obj.mentions === undefined
            ? undefined
            : parseMentions(obj.mentions, `${path}.mentions`, 'session/invalid-message');
    const data =
        obj.data === undefined
            ? undefined
            : takeSerializable(obj.data, `${path}.data`, 'session/invalid-message');

    // 本包自己产出的 tool-call 分支带私有载荷 `data.tool`；读回时按原强度校验它
    // （`data` 其余内容仍不解释）
    if (rawType === 'tool-call') parseTool(takeObject(data, `${path}.data`, 'session/invalid-message'), path);

    return {
        role: role as MessageRole,
        ...(seq === undefined ? {} : { seq }),
        ...(rawType === undefined ? {} : { type: rawType as MessageType }),
        ...(text === undefined ? {} : { text }),
        ...(mentions === undefined ? {} : { mentions }),
        ...(data === undefined ? {} : { data }),
        ...(at === undefined ? {} : { at }),
    };
}

/** 解析一组消息（压缩策略的返回值也要过这一关） */
export function parseMessages(value: unknown, path = 'messages'): ChatMessage[] {
    if (!Array.isArray(value)) {
        throw new SessionError('session/invalid-message', `期望消息数组，拿到 ${typeof value}`, path);
    }
    return value.map((item, index) => parseMessage(item, `${path}[${index}]`));
}

/**
 * `data` 槽位：只校验「装得下」（能 JSON 序列化：落盘 / 跨进程都靠它）。
 * 不校验内部 schema —— 那是上层的策略。
 */
function takeSerializable(value: unknown, path: string, code: 'session/invalid-message'): unknown {
    assertJsonValue(value, path, code, new Set());
    return value;
}

/**
 * 递归判「JSON 装得下」。为什么不用 `JSON.stringify` 一把梭：它把函数 / undefined / Symbol
 * **静默丢成 `{}` / 省略**——那正是「装不下却以为装下了」，落盘后内容就没了。
 */
function assertJsonValue(value: unknown, path: string, code: 'session/invalid-message', seen: Set<unknown>): void {
    if (value === null) return;
    const kind = typeof value;
    if (kind === 'string' || kind === 'boolean') return;
    if (kind === 'number') {
        if (!Number.isFinite(value as number)) {
            throw new SessionError(code, `data 不可 JSON 序列化（${String(value)} 不是有限数字）`, path);
        }
        return;
    }
    if (kind !== 'object') {
        throw new SessionError(code, `data 不可 JSON 序列化（含 ${kind}，落盘会静默丢失）`, path);
    }
    if (seen.has(value)) {
        throw new SessionError(code, 'data 不可 JSON 序列化（循环引用）', path);
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) assertJsonValue(item, path, code, seen);
    } else {
        const record = value as Record<string, unknown>;
        if (typeof record['toJSON'] === 'function') {
            seen.delete(value);
            return; // 自带序列化形状（Date 等）
        }
        for (const [key, item] of Object.entries(record)) assertJsonValue(item, `${path}.${key}`, code, seen);
    }
    seen.delete(value);
}

/** tool-call 分支的私有载荷校验（`data.tool`） */
function parseTool(data: Record<string, unknown>, path: string): ChatToolCall {
    const toolPath = `${path}.data.tool`;
    const obj = takeObject(data.tool, toolPath, 'session/invalid-message');
    rejectUnknown(obj, TOOL_KEYS, toolPath, 'session/invalid-message');
    if (!('args' in obj)) {
        throw new SessionError('session/invalid-message', 'tool.args 缺失（没有参数也要写 null）', `${toolPath}.args`);
    }
    return {
        name: takeString(obj.name, `${toolPath}.name`, 'session/invalid-message'),
        args: obj.args,
        id: takeString(obj.id, `${toolPath}.id`, 'session/invalid-message'),
    };
}

function parseMentions(value: unknown, path: string, code: 'session/invalid-message'): string[] {
    if (!Array.isArray(value)) {
        throw new SessionError(code, `期望字符串数组，拿到 ${typeof value}`, path);
    }
    return value.map((item, index) => takeString(item, `${path}[${index}]`, code));
}

/** 可选的非负数字：缺席 = undefined（不补 0 —— 「上游没报」与「报 0」是两回事） */
function optionalNonNegativeNumber(value: unknown, path: string): number | undefined {
    return value === undefined ? undefined : takeNonNegativeNumber(value, path, 'session/invalid-delta');
}

/** 自检一个流式增量（非法即抛 `session/invalid-delta`） */
export function assertDelta(value: unknown, path = 'delta'): SessionDelta {
    const obj = takeObject(value, path, 'session/invalid-delta');
    const type = takeString(obj.type, `${path}.type`, 'session/invalid-delta');
    if (type === 'text') {
        rejectUnknown(obj, ['type', 'text'], path, 'session/invalid-delta');
        return { type, text: takeString(obj.text, `${path}.text`, 'session/invalid-delta') };
    }
    if (type === 'tool-call') {
        rejectUnknown(obj, ['type', 'id', 'name', 'input'], path, 'session/invalid-delta');
        const input =
            obj.input === undefined ? undefined : takeString(obj.input, `${path}.input`, 'session/invalid-delta');
        return {
            type,
            id: takeString(obj.id, `${path}.id`, 'session/invalid-delta'),
            name: takeString(obj.name, `${path}.name`, 'session/invalid-delta'),
            ...(input === undefined ? {} : { input }),
        };
    }
    if (type === 'tool-result') {
        rejectUnknown(obj, ['type', 'id', 'content'], path, 'session/invalid-delta');
        return {
            type,
            id: takeString(obj.id, `${path}.id`, 'session/invalid-delta'),
            content: takeString(obj.content, `${path}.content`, 'session/invalid-delta'),
        };
    }
    if (type === 'usage') {
        // 缓存桶是 provider 层的附加事实（见 @diy/llm-provider 的 UsageDetail 头注）：
        // 允许出现，但**不并入** inputTokens —— 上游报的 input 已经含了它们。
        rejectUnknown(
            obj,
            ['type', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
            path,
            'session/invalid-delta',
        );
        const cacheReadTokens = optionalNonNegativeNumber(obj.cacheReadTokens, `${path}.cacheReadTokens`);
        const cacheWriteTokens = optionalNonNegativeNumber(obj.cacheWriteTokens, `${path}.cacheWriteTokens`);
        return {
            type,
            inputTokens: takeNonNegativeNumber(obj.inputTokens, `${path}.inputTokens`, 'session/invalid-delta'),
            outputTokens: takeNonNegativeNumber(obj.outputTokens, `${path}.outputTokens`, 'session/invalid-delta'),
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        };
    }
    if (type === 'done') {
        rejectUnknown(obj, ['type', 'stopReason'], path, 'session/invalid-delta');
        const stopReason =
            obj.stopReason === undefined
                ? undefined
                : takeString(obj.stopReason, `${path}.stopReason`, 'session/invalid-delta');
        return stopReason === undefined ? { type } : { type, stopReason };
    }
    throw new SessionError(
        'session/invalid-delta',
        `未知增量类型 ${type}（允许：text / tool-call / tool-result / usage / done）`,
        `${path}.type`,
    );
}

/** 工具参数：字符串按 JSON 解析（解析失败就原样保留字符串） */
export function toolArgsFromInput(input: string | undefined): unknown {
    if (input === undefined) return null;
    try {
        return JSON.parse(input);
    } catch {
        return input;
    }
}
