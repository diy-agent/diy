// id.ts —— 实体身份：UUIDv7（RFC 9562）+ 类型判定。
//
// 为什么不用 `crypto.randomUUID()`：那是 v4（全随机），建立顺序只能另存一列、另排序。
// v7 把毫秒放进前 48 位，`ORDER BY id` 就近似 `ORDER BY created_at`，跨实例也能排。
//
// 为什么不用 branded type（`string & { [brand]: 'uuidv7' }`）：它在 sqlite / http / jsonl
// 边界处全部丢失，每个边界都得 `as` 强转 —— 而 `as` 恰好是最需要校验的地方。
// 这里改成「运行时校验 + 单一构造入口」，边界上一个 `isEntityId()` 就够。
//
// 旧 id（`proj:diy` / `task-mwj3x9`）**不重写**：它们是历史数据的主键，改成 UUIDv7 会断掉
// journal / 消息 / 会话的外键。新实体才用 v7；`isEntityId()` 只用于「要发新 id」的入口。

import { randomBytes } from 'node:crypto';

/** 同毫秒内的顺序位（RFC 9562 §6.2 方法 1）：保证同一进程内 id 单调，不靠时钟精度 */
let lastMs = -1;
let seq = 0;

/**
 * 生成一个实体 id（UUIDv7，小写 36 字符）。
 *
 * `now` 可注入：测试要对「同一毫秒」的单调性下断言，不能靠等时钟。
 */
export function newEntityId(now: number = Date.now()): string {
    const ms = Math.max(now, lastMs);
    if (ms === lastMs) {
        seq = (seq + 1) & 0xfff;
    } else {
        lastMs = ms;
        // 新毫秒的起点也随机：否则「同一毫秒的第一条」永远是固定后缀，容易被猜到
        seq = randomBytes(2).readUInt16BE(0) & 0xfff;
    }

    const bytes = randomBytes(16);
    bytes.writeUIntBE(ms % 2 ** 48, 0, 6);
    bytes[6] = 0x70 | ((seq >> 8) & 0x0f); // version = 7
    bytes[7] = seq & 0xff;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant = 10xx

    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 是否 v7 形状（只用于「这里该出现一个新 id」的入口，不用于校验历史 id） */
export function isEntityId(value: unknown): value is string {
    return typeof value === 'string' && UUID_V7.test(value);
}

/** DIY 核心类型：闭合集合。插件类型一律带 `/`（见 splitPluginType） */
export const CORE_TYPES = ['project', 'task', 'bot'] as const;
export type CoreType = (typeof CORE_TYPES)[number];

export function isCoreType(type: string): type is CoreType {
    return (CORE_TYPES as readonly string[]).includes(type);
}

/** 插件类型里的局部名：不带 `.` `/` `@`，这样事件名与引用串都能反解 */
const LOCAL_TYPE = /^[a-z][a-z0-9_-]*$/;

export interface PluginTypeParts {
    /** npm 包名（含可选 scope）：`x` 或 `@acme/github` */
    pluginId: string;
    /** 插件内部的类型名：`issue` */
    local: string;
}

/**
 * 解析插件类型 `<plugin_id>/<local>`；不是插件类型返回 undefined。
 *
 * 形状判据来自 npm 自己：包名要么 `name`（不含 `/`），要么 `@scope/name`（恰好一个 `/`）。
 * 所以 `@a/b/c` = 插件 `@a/b` + 局部名 `c`，`x/y` = 插件 `x` + 局部名 `y`，无歧义。
 */
export function splitPluginType(type: string): PluginTypeParts | undefined {
    const parts = type.split('/');
    if (type.startsWith('@')) {
        if (parts.length !== 3) return undefined;
        const [scope, name, local] = parts as [string, string, string];
        if (scope.length < 2 || name === '' || !LOCAL_TYPE.test(local)) return undefined;
        return { pluginId: `${scope}/${name}`, local };
    }
    if (parts.length !== 2) return undefined;
    const [pluginId, local] = parts as [string, string];
    if (pluginId === '' || !LOCAL_TYPE.test(local)) return undefined;
    return { pluginId, local };
}

export function isPluginType(type: string): boolean {
    return splitPluginType(type) !== undefined;
}

/** 合法实体类型：core 或插件 */
export function isEntityType(type: string): boolean {
    return isCoreType(type) || isPluginType(type);
}

/**
 * 实体关系的三种 core kind（插件自定义的必须写成 `<plugin_id>/<kind>`）。
 *
 * - `related`：纯关联（平铺展示，无层级）
 * - `blocks`：A 没完成，B 别动（唯一会查环的一种）
 * - `duplicate`：同一件事的另一个入口
 */
export const LINK_KINDS = ['related', 'blocks', 'duplicate'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export function isLinkKind(kind: string): boolean {
    return (LINK_KINDS as readonly string[]).includes(kind) || isPluginType(kind);
}
