// index-list.ts —— 全部迁移的**有序注册表**。
//
// 文件名不叫 index.ts：那个名给了包的公开出口（`./index.js`），
// 这里只是「有哪些迁移、什么顺序」这一件事。

import { migration as m01 } from './001-rename-bot-roles.js';
import { migration as m02 } from './002-rename-role-config.js';
import { migration as m03 } from './003-create-tables.js';
import { migration as m04 } from './004-entity-bots.js';
import { migration as m05 } from './005-deliveries-columns.js';
import { migration as m06 } from './006-session-log-seq.js';
import { migration as m07 } from './007-session-bot-column.js';
import { migration as m08 } from './008-bot-profile-columns.js';
import { migration as m09 } from './009-clear-placeholder-model.js';
import { migration as m10 } from './010-tasks-updated-at.js';
import { migration as m11 } from './011-task-units-parent.js';
import { migration as m12 } from './012-drop-unit-deps.js';
import { migration as m13 } from './013-legacy-rooms.js';
import { migration as m14 } from './014-fold-bots.js';
import { migration as m15 } from './015-legacy-journal.js';
import { migration as m16 } from './016-drop-legacy-room-model.js';
import type { Migration } from './types.js';

/**
 * 全部迁移，**顺序 = 执行顺序**。
 *
 * 为什么手写数组、不用生成器（opencode 用 drizzle-kit 生成）：这里只有十几条，
 * 而且顺序本身承载语义（两条表改名必须赶在建表之前）—— 让它在代码里一眼看得见，
 * 比藏在时间戳文件名里更不容易出错。真要上百条时再上生成器。
 */
export const migrations: readonly Migration[] = [
    m01,
    m02,
    m03,
    m04,
    m05,
    m06,
    m07,
    m08,
    m09,
    m10,
    m11,
    m12,
    m13,
    m14,
    m15,
    m16,
];

/** 迁移步骤清单（给迁移页画总进度条用：分母得先知道） */
export const MIGRATION_STEPS: ReadonlyArray<{ id: string; title: string }> = migrations.map((migration) => ({
    id: migration.id,
    title: migration.title,
}));
