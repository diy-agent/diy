// verify-migrations.ts —— 迁移跑完之后的**自检**：库真的是一致的样子吗？
//
// 为什么要它（2026-11-27）：迁移跑完只看「步骤都 done」是不够的 ——
// 步骤能 done 而数据仍可能留下对不上的行（孤儿引用、行数与身份表不符）。
// 那类问题以前要靠人读 SQL 才发现，而它们一旦被读路径撞上就是 500。
//
// 分成两级（为什么不一刀切全 fatal）：
//   · error：破了这条库就是错的，**必须报错**（启动 / 迁移都停）——
//     版本表不齐、域表没有身份行、任务指向不存在的项目、记录挂在不存在的东西上。
//   · warn：记录表的孤儿行（`entity_items` 没有外键，历史调试留下的行现实存在）。
//     它不影响读写正确性（没人读那段），报出来即可 —— 拿它拦启动 = 又一次「用户进不去」。
//
// 判据只读（SELECT COUNT），不修数据：**自检不是清洗**。要清就写一条迁移，别在这里偷偷改库。

import { missingMigrations } from '@diy-agent/migration';
import type { MigrationRuntime } from '@diy-agent/migration';

export type VerifyLevel = 'error' | 'warn';

/** 一条自检结论：哪一项、多严重、涉及多少行、一句话 */
export interface VerifyFinding {
    /** 稳定 id（日志 / 测试按它断言） */
    check: string;
    level: VerifyLevel;
    /** 命中多少行（0 = 该项通过，不会出现在结果里） */
    count: number;
    /** 给人看的一句话（含怎么修） */
    detail: string;
}

/** 一条自检的定义：跑一次 COUNT，0 就是健康 */
interface Check {
    id: string;
    level: VerifyLevel;
    /** 计数 SQL（返回 0 = 通过） */
    sql: string;
    detail: string;
}

const CHECKS: Check[] = [
    {
        id: 'version-table',
        level: 'error',
        // 版本表里缺了代码里的迁移 —— 迁移器自己没跑完（正常路径不可能，所以它是硬错）
        sql: '', // 特殊：走 missingMigrations()，见 runChecks
        detail: '版本表缺少代码里的迁移记录（迁移没跑完）',
    },
    {
        id: 'orphan-tasks',
        level: 'error',
        sql: 'SELECT COUNT(*) AS n FROM tasks t LEFT JOIN entities e ON e.id = t.id WHERE e.id IS NULL',
        detail: 'tasks 有行没有对应的 entities 身份行（域表必须 1:1 挂在实体上）',
    },
    {
        id: 'orphan-projects',
        level: 'error',
        sql: 'SELECT COUNT(*) AS n FROM projects p LEFT JOIN entities e ON e.id = p.id WHERE e.id IS NULL',
        detail: 'projects 有行没有对应的 entities 身份行',
    },
    {
        id: 'dangling-project',
        level: 'error',
        sql: 'SELECT COUNT(*) AS n FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.project_id IS NOT NULL AND p.id IS NULL',
        detail: 'tasks.project_id 指向不存在的项目',
    },
    {
        id: 'orphan-task-units',
        level: 'error',
        sql: 'SELECT COUNT(*) AS n FROM task_units u LEFT JOIN tasks t ON t.id = u.task_id WHERE t.id IS NULL',
        detail: 'task_units 挂在不存在的任务上',
    },
    {
        id: 'orphan-room-members',
        level: 'error',
        sql: 'SELECT COUNT(*) AS n FROM room_members m LEFT JOIN entities e ON e.id = m.entity_id WHERE e.id IS NULL',
        detail: 'room_members 挂在不存在的实体上',
    },
    {
        id: 'orphan-room-members-bot',
        level: 'error',
        sql: 'SELECT COUNT(*) AS n FROM room_members m LEFT JOIN bot_profiles b ON b.id = m.bot_id WHERE b.id IS NULL',
        detail: 'room_members.bot_id 指向不存在的角色（会渲染出空成员）',
    },
    {
        id: 'orphan-room-entries',
        level: 'error',
        sql: 'SELECT COUNT(*) AS n FROM room_entries r LEFT JOIN entities e ON e.id = r.entity_id WHERE e.id IS NULL',
        detail: 'room_entries 挂在不存在的实体上',
    },
    {
        id: 'orphan-sessions',
        level: 'error',
        sql: 'SELECT COUNT(*) AS n FROM session_state s LEFT JOIN entities e ON e.id = s.entity_id WHERE e.id IS NULL',
        detail: 'session_state 挂在不存在的实体上',
    },
    {
        id: 'orphan-entity-items',
        level: 'warn',
        sql: 'SELECT COUNT(*) AS n FROM entity_items i LEFT JOIN entities e ON e.id = i.entity_id WHERE e.id IS NULL',
        detail: 'entity_items 挂在不存在的实体上（记录表无外键；历史调试行会留在这里）',
    },
    {
        // 不数「行数是否相等」：老库里可能先有 entities 行、任务表后建（迁移中途的形态），
        // 那是历史残留而不是错。真正会咬人的是**类型对不上** —— 域表行挂着的身份不是它该有的类型。
        id: 'type-tasks',
        level: 'error',
        sql: "SELECT COUNT(*) AS n FROM tasks t JOIN entities e ON e.id = t.id WHERE e.type <> 'task'",
        detail: 'tasks 的身份行类型不是 task',
    },
    {
        id: 'type-projects',
        level: 'error',
        sql: "SELECT COUNT(*) AS n FROM projects p JOIN entities e ON e.id = p.id WHERE e.type <> 'project'",
        detail: 'projects 的身份行类型不是 project',
    },
];

function count(db: MigrationRuntime['db'], sql: string): number {
    try {
        return (db.prepare(sql).get() as { n: number }).n;
    } catch {
        // 表还不存在（迁移前的库）→ 这一项不适用，不算问题
        return 0;
    }
}

/**
 * 跑一遍自检，返回**没通过**的项（通过的不返回）。
 *
 * 只读：不修、不清、不加锁。调用方决定是「报错停下」还是「只记一条警告」。
 */
export function verifyDatabase(runtime: MigrationRuntime): VerifyFinding[] {
    const findings: VerifyFinding[] = [];
    for (const check of CHECKS) {
        const n = check.id === 'version-table' ? missingMigrations(runtime.db).length : count(runtime.db, check.sql);
        if (n > 0) findings.push({ check: check.id, level: check.level, count: n, detail: check.detail });
    }
    return findings;
}

/** 自检结论压成一行（日志 / 迁移事件都只放得下一行） */
export function describeFindings(findings: VerifyFinding[]): string {
    return findings.map((item) => `${item.check}×${String(item.count)}`).join('、');
}
