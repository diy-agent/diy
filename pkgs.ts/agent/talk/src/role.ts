// role.ts — role 翻译铁律（##166 §一 结论 5 + §3.5 对照表）
//
// 铁律：**他人的发言装配进 LLM 请求时绝不能是 `assistant`** —— 那等于宣称
// 「这条回复是我的端点产生的」，而它明明是别人说的。这不是风格问题，是 LLM 请求规范问题。
// 例外仅限真正共用同一 API session 的连续轮次（DIY 不属此例），故本包**刻意不提供例外开关**。
//
// 本包只给「一条内容该装配成哪个 role」的纯函数与断言；装配成 messages[] 是 ##314 的事。

import { TalkError } from './errors.js';

/** 装配到 LLM 请求时的 role（本包只产出这两种；程序化系统事件归 ##313 的泳道容器） */
export type AssemblyRole = 'user' | 'assistant';

/**
 * 内容来源的类别（决定 role 的唯一轴 = 这条内容是不是「我的端点产出的」）：
 * - `speech`   有人说了话（agent / 人）→ 自己 = assistant，他人 = user
 * - `trace`    tool / thinking 等过程产物 → 只可能是自己的（他人过程私有，不投递）
 * - `material` 文档修订等资料 → 对模型是外部事实，谁写的都是 user（没人跟它说话）
 */
export const SOURCE_KINDS = ['speech', 'trace', 'material'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface RoleInput {
    kind: SourceKind;
    /** 内容的作者 */
    author: string;
    /** 本次请求的 agent 自己（装配对象） */
    self: string;
}

/**
 * 翻译一条内容的 role；违反结构前提立即抛 `role-violation`：
 * 未知来源类别（JS 调用方 / `as any` 转发也可能传进来，review1 意见 1）、
 * 他人 trace 进装配、author / self 未指定。
 */
export function assemblyRole(input: RoleInput): AssemblyRole {
    const { kind, author, self } = input;
    // 先校验判别键：非法 kind 绝不能静默走 speech 分支（那会让「他人 trace」漏网）
    if (!(SOURCE_KINDS as readonly string[]).includes(kind)) {
        throw new TalkError('role-violation', `未知来源类别 ${JSON.stringify(kind)}（合法：${SOURCE_KINDS.join(' | ')}）`, 'kind');
    }
    if (author === '') throw new TalkError('role-violation', 'author 不能为空', 'author');
    if (self === '') throw new TalkError('role-violation', 'self（装配对象）不能为空：没有「我」就无从判断哪条是自己的', 'self');
    if (kind === 'trace' && author !== self) {
        throw new TalkError(
            'role-violation',
            `他人的过程产物（tool / thinking）不得进入本次装配：author=${author} self=${self}`,
            'kind',
        );
    }
    if (kind === 'material') return 'user';
    return author === self ? 'assistant' : 'user';
}

export interface RoleAssignment extends RoleInput {
    role: AssemblyRole;
}

/**
 * 校验一批装配决策是否守住铁律（装配侧提交 messages 前调一次）。
 * 逐条与 `assemblyRole` 的期望值核对 —— 任何「他人 → assistant」都会被拦下。
 */
export function assertRoleAssignments(assignments: readonly RoleAssignment[]): void {
    assignments.forEach((assignment, i) => {
        const expected = assemblyRole(assignment);
        if (assignment.role === expected) return;
        if (assignment.role === 'assistant') {
            throw new TalkError(
                'role-violation',
                `他人发的言被装配成 assistant：author=${assignment.author} self=${assignment.self}`,
                `[${i}].role`,
            );
        }
        throw new TalkError('role-violation', `role 与来源不符：期望 ${expected}，实得 ${assignment.role}`, `[${i}].role`);
    });
}
