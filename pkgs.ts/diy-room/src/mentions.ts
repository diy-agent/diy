// mentions.ts — `@` 寻址解析
//
// 规则（与既有 room 行为对齐，但只保留「投递」这一层）：
//   `@all`            → 所有 agent 成员（发言人自己除外）
//   `@name` / `@id`   → 精确匹配成员（先按 name，再按 id）
//   正文里没有 `@`    → 退到 focus；focus 也没有 → 只落记录（recipients = []）
//
// 点名了不存在的人 ⇒ `room/unknown-recipient`。静默忽略的话，发言者会以为送到了。

import { RoomError } from './errors.js';
import type { RoomMember } from './types.js';

const MENTION_RE = /@([A-Za-z0-9_:.\-\u4e00-\u9fff]+)/g;

/** 正文里出现的 `@xxx` 名字（去重、保序） */
export function parseMentions(text: string): string[] {
    const out: string[] = [];
    for (const match of text.matchAll(MENTION_RE)) {
        const name = match[1];
        if (!out.includes(name)) out.push(name);
    }
    return out;
}

/**
 * 把「收件人标识」解析成成员 id。
 * 入参里的成员标识可以是 name 或 id；`@all` 展开成全部 agent。
 */
export function resolveRecipients(input: {
    tokens: readonly string[];
    members: readonly RoomMember[];
    authorId: string;
}): string[] {
    const byId = new Map(input.members.map((m) => [m.id, m]));
    const byName = new Map<string, RoomMember[]>();
    for (const member of input.members) {
        const list = byName.get(member.name) ?? [];
        list.push(member);
        byName.set(member.name, list);
    }

    const out: string[] = [];
    for (const token of input.tokens) {
        const normalized = token.startsWith('@') ? token.slice(1) : token;
        if (normalized === 'all') {
            for (const member of input.members) {
                if (member.kind === 'agent' && member.id !== input.authorId) push(out, member.id);
            }
            continue;
        }
        const member = byId.get(normalized) ?? pickByName(byName.get(normalized) ?? [], normalized);
        if (!member) {
            throw new RoomError('room/unknown-recipient', `房间里没有成员 ${normalized}`, 'to');
        }
        if (member.id !== input.authorId) push(out, member.id);
    }
    return out;
}

/** 同名成员：优先 agent（人通常叫「我」这类泛称，agent 名更具体），仍有歧义就报错 */
function pickByName(candidates: RoomMember[], name: string): RoomMember | undefined {
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    const agents = candidates.filter((m) => m.kind === 'agent');
    if (agents.length === 1) return agents[0];
    throw new RoomError(
        'room/unknown-recipient',
        `成员名 ${name} 有歧义（${candidates.length} 个同名），请用 id 寻址`,
        'to',
    );
}

function push(list: string[], id: string): void {
    if (!list.includes(id)) list.push(id);
}
