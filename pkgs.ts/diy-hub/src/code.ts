// 邀请码：6 位 Base32（Crockford），显示形态 `7K9M-Q2`。
//
// 只做「码的形态 / 归一 / 生成」，**不做存储与校验**（那是 invitation.ts + store）。

import { randomBytes } from 'node:crypto';
import { HubError } from './errors.js';
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from './types.js';

/** 生成 6 位码（无 I/L/O/U，口述不易混）。`randomBytes` 注入只为测试可复现。 */
export function generateInviteCode(random: (n: number) => Buffer = randomBytes): string {
    const bytes = random(INVITE_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
        // 256 % 32 === 0，取模无偏
        code += INVITE_CODE_ALPHABET[bytes[i]! % INVITE_CODE_ALPHABET.length];
    }
    return code;
}

/** 归一：大写、去掉分隔符（`7k9m-q2` → `7K9MQ2`）。非法形态一律抛，不猜。 */
export function normalizeInviteCode(input: string): string {
    const code = input
        .trim()
        .toUpperCase()
        .replace(/[\s-_]/g, '');
    if (!isInviteCodeShape(code)) {
        throw new HubError('hub/bad-input', `邀请码应为 ${INVITE_CODE_LENGTH} 位 Base32（如 7K9M-Q2）`, input);
    }
    return code;
}

export function isInviteCodeShape(code: string): boolean {
    if (code.length !== INVITE_CODE_LENGTH) return false;
    for (const ch of code) {
        if (!INVITE_CODE_ALPHABET.includes(ch)) return false;
    }
    return true;
}

/** 显示形态：`7K9MQ2` → `7K9M-Q2`（人读 / 口述用；存储与比较一律用归一形态） */
export function formatInviteCode(code: string): string {
    const c = normalizeInviteCode(code);
    return `${c.slice(0, 4)}-${c.slice(4)}`;
}
