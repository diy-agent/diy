// message.ts — 消息与增量的解析 / 自检
//
// 消息形状 = 设计定稿 `session-design.md` §二的 Entry（多一个给 LLM 看的 `role`）：
//   { seq, at, kind, text?, tool?, mentions? , role }
//
// 两条铁律：
//   ① 消息形状不对 ⇒ `session/invalid-message`（带点路径）；
//   ② LlmPort 吐出别的东西 ⇒ `session/invalid-delta`——适配器写错了要立刻炸在边界上，
//      不能让半条内容流进历史。

import { SessionError } from './errors.js';
import type { ChatMessage, ChatToolCall, MessageKind, MessageRole, SessionDelta } from './types.js';
import { rejectUnknown, takeNonNegativeInteger, takeNonNegativeNumber, takeObject, takeString } from './validate.js';

export const MESSAGE_ROLES: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool'];

export const MESSAGE_KINDS: readonly MessageKind[] = [
    'human',
    'agent-conclusion',
    'agent-notice',
    'agent-trace',
    'tool-call',
    'tool-result',
];

/** 缺省 kind 推导：user 是人说的话，assistant 默认是本轮结论，tool 是工具结果；system 无分类 */
const DEFAULT_KIND: Partial<Record<MessageRole, MessageKind>> = {
    user: 'human',
    assistant: 'agent-conclusion',
    tool: 'tool-result',
};

const MESSAGE_KEYS = ['seq', 'role', 'kind', 'text', 'tool', 'mentions', 'at'] as const;
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

    const rawKind = obj.kind === undefined ? DEFAULT_KIND[role as MessageRole] : obj.kind;
    if (rawKind !== undefined && !MESSAGE_KINDS.includes(rawKind as MessageKind)) {
        throw new SessionError(
            'session/invalid-message',
            `未知消息分类 ${String(rawKind)}（允许：${MESSAGE_KINDS.join(' / ')}）`,
            `${path}.kind`,
        );
    }

    const seq =
        obj.seq === undefined ? undefined : takeNonNegativeInteger(obj.seq, `${path}.seq`, 'session/invalid-message');
    const at =
        obj.at === undefined ? undefined : takeNonNegativeNumber(obj.at, `${path}.at`, 'session/invalid-message');
    const text = obj.text === undefined ? undefined : takeString(obj.text, `${path}.text`, 'session/invalid-message');
    const tool = obj.tool === undefined ? undefined : parseTool(obj.tool, `${path}.tool`);
    const mentions =
        obj.mentions === undefined
            ? undefined
            : parseMentions(obj.mentions, `${path}.mentions`, 'session/invalid-message');

    return {
        role: role as MessageRole,
        ...(seq === undefined ? {} : { seq }),
        ...(rawKind === undefined ? {} : { kind: rawKind as MessageKind }),
        ...(text === undefined ? {} : { text }),
        ...(tool === undefined ? {} : { tool }),
        ...(mentions === undefined ? {} : { mentions }),
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

function parseTool(value: unknown, path: string): ChatToolCall {
    const obj = takeObject(value, path, 'session/invalid-message');
    rejectUnknown(obj, TOOL_KEYS, path, 'session/invalid-message');
    if (!('args' in obj)) {
        throw new SessionError('session/invalid-message', 'tool.args 缺失（没有参数也要写 null）', `${path}.args`);
    }
    return {
        name: takeString(obj.name, `${path}.name`, 'session/invalid-message'),
        args: obj.args,
        id: takeString(obj.id, `${path}.id`, 'session/invalid-message'),
    };
}

function parseMentions(value: unknown, path: string, code: 'session/invalid-message'): string[] {
    if (!Array.isArray(value)) {
        throw new SessionError(code, `期望字符串数组，拿到 ${typeof value}`, path);
    }
    return value.map((item, index) => takeString(item, `${path}[${index}]`, code));
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
        rejectUnknown(obj, ['type', 'inputTokens', 'outputTokens'], path, 'session/invalid-delta');
        return {
            type,
            inputTokens: takeNonNegativeNumber(obj.inputTokens, `${path}.inputTokens`, 'session/invalid-delta'),
            outputTokens: takeNonNegativeNumber(obj.outputTokens, `${path}.outputTokens`, 'session/invalid-delta'),
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
