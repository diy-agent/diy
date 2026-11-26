// room.ts —— 房间的**纯函数**：成员解析、模型/人格继承、@ 解析。
//
// 这里是唯一的实现点：后端路由、前端补全、UI 文案都从这里取，不再各写一份。

import type { Bot, BotRole, RoleConfig, Room, RoomMember } from './types';

// ── 角色 → 成员（派生的唯一实现）─────────────────────────────────

/**
 * 一种类型的成员名单：`type` 相同的角色，primary 排头，其余按建得早的在前。
 *
 * 排序不能是随机的：侧栏、@ 补全、`primaryMemberOf` 都按「第一位成员」兜底，
 * 顺序一变，同一个房间的默认应答就跟着变。
 */
export function membersOfType(roles: readonly BotRole[], type: string): RoomMember[] {
    return roles
        .filter((role) => role.type === type)
        .sort((left, right) =>
            left.primary === right.primary
                ? left.createdAt - right.createdAt || left.id.localeCompare(right.id)
                : left.primary
                  ? -1
                  : 1,
        )
        .map((role) => ({ botId: role.id, ...(role.primary ? { primary: true } : {}) }));
}

/** 角色 → 房间里的化身（`persona` / `modelKey` 的落点，唯一转换处） */
export function botOfRole(role: BotRole, config?: RoleConfig): Bot {
    return {
        id: role.id,
        name: role.name,
        color: role.color,
        persona: role.instructions,
        // 空串与 null 同义（没填）：先走 bot 的 override，再走类型默认，房间侧靠 `||` 继续往下继承
        modelKey: role.modelKey || config?.modelKey || '',
    };
}

// ── 成员 ──────────────────────────────────────────────────────

export function membersOf(room: Room): readonly RoomMember[] {
    return room.members;
}

export function memberOf(room: Room, botId: string): RoomMember | undefined {
    return room.members.find((member) => member.botId === botId);
}

/** 默认应答：显式 primary 优先，否则第一位成员 */
export function primaryMemberOf(room: Room): RoomMember | undefined {
    return room.members.find((member) => member.primary === true) ?? room.members[0];
}

/** 成员 id 列表（保持声明顺序） */
export function botIdsOf(room: Room): string[] {
    return room.members.map((member) => member.botId);
}

/** 房间里的 bot（过滤掉已被删除的身份） */
export function botsOf(room: Room, bots: Record<string, Bot>): Bot[] {
    return room.members.map((member) => bots[member.botId]).filter((bot): bot is Bot => bot !== undefined);
}

// ── 继承：成员 > 房间 > bot 自己 ────────────────────────────────

/**
 * 成员 > 房间 > bot 三级覆盖；**空串 = 继续往下继承**（再没有就是「用目录的 defaultModel」）。
 *
 * 不能只靠 `??`：空串是真值语义上的「没填」，而 `??` 只跳过 null/undefined —— 于是
 * 一行 `modelKey: ''` 会把后面的真实值挡掉，最后拿空 key 去发请求。
 */
export function effectiveModelOf(room: Room, bot: Bot): string {
    return memberOf(room, bot.id)?.modelKey || room.modelKey || bot.modelKey || '';
}

export function effectivePersonaOf(room: Room, bot: Bot): string {
    return memberOf(room, bot.id)?.persona ?? bot.persona;
}

/** 把成员覆盖套到身份上，得到一个"在这个房间里"的 bot */
export function inRoom(room: Room, bot: Bot): Bot {
    return {
        ...bot,
        persona: effectivePersonaOf(room, bot),
        modelKey: effectiveModelOf(room, bot),
    };
}

// ── @ 解析（唯一实现）──────────────────────────────────────────

/**
 * 找出文本里被 @ 的名字。
 *   · `@all` 原样返回，由调用方决定怎么解释（人 → 全员；bot → 忽略）
 *   · 只取一段不含空白和 @ 的连续字符；两端常见标点自动剥掉
 */
export function mentionsOf(text: string): string[] {
    const out: string[] = [];
    for (const match of text.matchAll(/@([^\s@]+)/g)) {
        const raw = match[1] ?? '';
        const name = raw.replace(/[，。！？、；：,.!?;:）)】\]]+$/u, '');
        if (name !== '') out.push(name);
    }
    return out;
}
