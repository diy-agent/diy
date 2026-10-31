// 实例身份的**落盘与读取**（真源判据在 `src/identity.ts`，这里只做 IO）。
//
// 落位（相对 `$DIY_HOME`）：
//   `instance-id`    永不变的 id（首次启动写一次；之后只读）
//   `instance-name`  用户改过的显示名（没有 ⇒ 显示 hostname）
//
// 读侧一律宽松：文件缺失 / 空 / 读失败都当「没有」，绝不因为一个坏文件起不来实例。

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
    ID_FILENAME,
    NAME_FILENAME,
    resolveIdentity,
    type InstanceIdentity,
    type ResolvedIdentity,
    type StoredIdentity,
} from '../identity.js';
import { writeFileAtomic } from './atomic-write.js';

function readText(file: string): string | null {
    try {
        const text = readFileSync(file, 'utf-8');
        return text.trim() === '' ? null : text;
    } catch {
        return null;
    }
}

/** 读两样原料（id / 名字 / 当前 hostname） */
export function readStoredIdentity(home: string, opts: { hostname?: string } = {}): StoredIdentity {
    return {
        storedId: readText(join(home, ID_FILENAME)),
        storedName: readText(join(home, NAME_FILENAME)),
        hostname: opts.hostname ?? hostname() ?? '',
    };
}

/**
 * 解析身份，并在**首次启动**时把新 id 落盘（这是 id 生命周期里唯一一次写）。
 *
 * ⚠️ 已有 `instance-id` 时绝不覆盖 —— 哪怕 hostname 变了、用户改了显示名。
 * 覆盖 = 远端认不出这台机器（用户裁决：hostname 可以改，id 不能跟着变）。
 */
export function ensureIdentity(
    home: string,
    opts: { hostname?: string; generateId?: () => string } = {},
): ResolvedIdentity {
    const resolved = resolveIdentity(readStoredIdentity(home, opts), opts.generateId);
    if (resolved.newId !== null) {
        try {
            writeFileAtomic(join(home, ID_FILENAME), `${resolved.newId}\n`);
        } catch (e) {
            // 写不进去（只读盘 / 权限）：本次进程照常带这个 id 跑，下次启动会再生成一个 ——
            // 这比「起不来」好，但必须留痕，否则「id 怎么变了」无从追。
            console.error(`[remote] 实例 id 落盘失败（${home}/${ID_FILENAME}）：`, e);
        }
    }
    return resolved;
}

/** 改显示名（空串 = 清除用户设定，回落到 hostname）；返回改完的身份 */
export function setDisplayName(home: string, displayName: string, opts: { hostname?: string } = {}): InstanceIdentity {
    const name = displayName.trim();
    const file = join(home, NAME_FILENAME);
    if (name === '') {
        try {
            // 清空文件内容 = 没有用户设定（不删文件：删了与「从没设过」在语义上等价，但保留文件更好排查）
            writeFileAtomic(file, '');
        } catch {
            /* 忽略 */
        }
    } else {
        writeFileAtomic(file, `${name}\n`);
    }
    return ensureIdentity(home, opts).identity;
}
