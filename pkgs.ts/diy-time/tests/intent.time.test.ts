// tests/intent.time.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 @diy-agent/time「意图测试」—— 需求级（对应 ##483 判据）
//
//   T1  形状：`2026-10-31T11:29:25.403+0800`（判据①的正则）
//   T2  round-trip：`new Date(localISOString(d))` 回到**同一时刻**（判据③）
//   T3  与 UTC 同一 instant：换格式不换时刻（不是"把 UTC 数字改个后缀"）
//   T4  偏移取自当期本地时区（有 DST 的时区夏冬不同，不能是常量）
//   T5  本地日期键：跨 UTC 日界时仍是**本地**那一天（`toISOString().slice(0,10)` 会差一天）
//   T6  排序：不同偏移的串字典序 ≠ 时间序，`compareInstant` 才是时间序
//   T7  坏输入：坏 Date 抛 TimeError（不产出假时间串）；非法串比较恒排最后
//
// 不 mock 时区：断言的都是「与本地时区无关也成立」的性质，故本机 / CI 各时区都过。
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import { compareInstant, instantOf, localDateKey, localISOString, localOffset, TimeError } from '../src/index.js';

/** 判据①的形状：毫秒三位 + 偏移四位（不带冒号） */
const SHAPE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/;

describe('localISOString', () => {
    it('T1 形状是 本地时刻 + 四位偏移', () => {
        const d = new Date(2026, 9, 31, 11, 29, 25, 403);
        const s = localISOString(d);
        expect(s).toMatch(SHAPE_RE);
        expect(s.startsWith('2026-10-31T11:29:25.403')).toBe(true);
    });

    it('T2 round-trip 回到同一时刻（毫秒不丢）', () => {
        for (const d of [
            new Date(2026, 9, 31, 11, 29, 25, 403),
            new Date(2026, 0, 1, 0, 0, 0, 0),
            new Date(2026, 11, 31, 23, 59, 59, 999),
            new Date(2024, 1, 29, 12, 0, 0, 1),
        ]) {
            expect(new Date(localISOString(d)).getTime()).toBe(d.getTime());
        }
    });

    it('T3 与 toISOString 是同一 instant（只换表达，不换时刻）', () => {
        const d = new Date(2026, 9, 31, 11, 29, 25, 403);
        expect(instantOf(localISOString(d))).toBe(instantOf(d.toISOString()));
    });

    it('T4 偏移 = 当期本地偏移（符号与 getTimezoneOffset 相反）', () => {
        const d = new Date(2026, 9, 31, 11, 29, 25, 403);
        const minutes = -d.getTimezoneOffset();
        const abs = Math.abs(minutes);
        const want = `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
        expect(localOffset(d)).toBe(want);
        expect(localISOString(d).endsWith(want)).toBe(true);
    });

    it('T7 坏 Date 抛 TimeError（不产出假时间串）', () => {
        const bad = new Date(Number.NaN);
        expect(() => localISOString(bad)).toThrow(TimeError);
        try {
            localISOString(bad);
        } catch (e) {
            expect((e as TimeError).code).toBe('time/invalid-date');
        }
    });
});

describe('localDateKey', () => {
    it('T5 是本地那一天（凌晨 0:30 也不退到前一天）', () => {
        const d = new Date(2026, 9, 31, 0, 30, 0, 0);
        expect(localDateKey(d)).toBe('2026-10-31');
    });

    it('T5 月 / 日补零', () => {
        expect(localDateKey(new Date(2026, 0, 5, 12, 0, 0, 0))).toBe('2026-01-05');
    });
});

describe('compareInstant / instantOf', () => {
    it('T6 同一时刻不同偏移 → 0（字典序会误判）', () => {
        const utc = '2026-10-31T03:00:00.000Z';
        const local = '2026-10-31T11:00:00.000+0800';
        expect(compareInstant(utc, local)).toBe(0);
        // 字典序在这里给出的是错的（`03` < `11`），这正是不能用 `<` 比串的理由
        expect(utc < local).toBe(true);
    });

    it('T6 跨偏移按真实先后排序', () => {
        // 10-30 23:00Z 比 10-31 01:00+0800（= 10-30 17:00Z）**晚**，字典序却说它早
        const earlier = '2026-10-31T01:00:00.000+0800';
        const later = '2026-10-30T23:00:00.000Z';
        expect(compareInstant(earlier, later)).toBe(-1);
        expect(compareInstant(later, earlier)).toBe(1);
        expect(later < earlier).toBe(true); // 字典序的错答案（它说 Z 那条更早），钉住它
    });

    it('T6 非法 / 空串恒排最后（与升降序无关）', () => {
        const ok = '2026-10-31T11:00:00.000+0800';
        expect(compareInstant(ok, '')).toBe(-1);
        expect(compareInstant('', ok)).toBe(1);
        expect(compareInstant('', 'x')).toBe(0);
        expect(Number.isNaN(instantOf('x'))).toBe(true);
    });
});
