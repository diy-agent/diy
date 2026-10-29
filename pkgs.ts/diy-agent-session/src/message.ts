// message.ts — 消息与增量的解析 / 自检
//
// 两条铁律：
//   ① 消息形状不对 ⇒ `session/invalid-message`（带点路径）；
//   ② LlmPort 吐出别的东西 ⇒ `session/invalid-delta`——适配器写错了要立刻炸在边界上，
//      不能让半条内容流进历史。

import { SessionError } from './errors.js';
import type { ChatMessage, MessageKind, MessageRole, SessionDelta } from './types.js';
import { rejectUnknown, takeIsoString, takeNonNegativeNumber, takeObject, takeString } from './validate.js';

export const MESSAGE_ROLES: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool'];

export const MESSAGE_KINDS: readonly MessageKind[] = [
    'human',
    'agent-conclusion',
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

const MESSAGE_KEYS = ['role', 'kind', 'content', 'at', 'name', 'toolCallId'] as const;

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
    const kind = rawKind as MessageKind | undefined;
    const content = takeString(obj.content, `${path}.content`, 'session/invalid-message');
    const at = obj.at === undefined ? undefined : takeIsoString(obj.at, `${path}.at`, 'session/invalid-message');
    const name = obj.name === undefined ? undefined : takeString(obj.name, `${path}.name`, 'session/invalid-message');
    const toolCallId =
        obj.toolCallId === undefined
            ? undefined
            : takeString(obj.toolCallId, `${path}.toolCallId`, 'session/invalid-message');
    const message: ChatMessage = { role: role as MessageRole, content };
    return {
        ...message,
        ...(kind === undefined ? {} : { kind }),
        ...(at === undefined ? {} : { at }),
        ...(name === undefined ? {} : { name }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
    };
}

/** 解析一组消息（压缩策略的返回值也要过这一关） */
export function parseMessages(value: unknown, path = 'messages'): ChatMessage[] {
    if (!Array.isArray(value)) {
        throw new SessionError('session/invalid-message', `期望消息数组，拿到 ${typeof value}`, path);
    }
    return value.map((item, index) => parseMessage(item, `${path}[${index}]`));
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
