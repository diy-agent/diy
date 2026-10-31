// tests/intent.log.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 @diy-agent/log「意图测试」—— 需求级（对应 ##482 判据）
//
//   T1  统一流：不同 source 写进**同一份文件**，靠 source 字段过滤
//   T2  级别过滤：level=warn ⇒ debug/info 不落盘
//   T3  不给全局单例：两个 logger 各自独立；child 固定 source；traceId 可继承
//   T4  按天：文件名带本地日期，跨天自动换文件
//   T5  按大小轮转：超 maxBytes 滚 `.1` `.2`，超 maxFiles 删最旧（判据 4 实测）
//   T6  重开续写：同一天新建 logger 接着原文件写，按已有大小判轮转
//   T7  data 有界：大对象截成 `{truncated,bytes}`，循环引用不崩
//   T8  err 带栈：Error / 非 Error / cause 都有形状
//   T9  配置错误带 code；close 之后不再写
//   T10 按天清理：超过 maxDays 的旧日期组被删
//   T11 写盘失败不抛（日志是旁路），走 onError
//
// 真文件系统（临时目录），不 mock fs —— 这层要验的就是落盘行为本身。
// ═══════════════════════════════════════════════════════════════

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, isLogLevel, LogError, type LogRecord } from '../src/index.js';

let dir: string;
/** 可推进的假钟：日期 / 轮转都按它算，测试不依赖真实时间 */
let clock: number;
const T0 = new Date(2026, 9, 31, 10, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diy-log-'));
    clock = T0;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const now = (): Date => new Date(clock);

/** 本地日期键（与被测实现分开算：测试要有自己的期望，不能复用同一段代码） */
function dayName(date: Date): string {
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const today = (): string => dayName(now());

async function readRecords(file: string): Promise<LogRecord[]> {
    const text = await readFile(file, 'utf8');
    if (text.trim() === '') return [];
    return text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LogRecord);
}

describe('@diy-agent/log', () => {
    it('T1 统一流：不同 source 写同一份文件，靠 source 过滤', async () => {
        const logger = createLogger({ dir, now });
        logger.child('main:chat').info('窗口已创建', { variant: 'lab' });
        logger.child('app:remote-shell').warn('连接断开', { url: 'http://127.0.0.1:8080' });
        await logger.flush();

        expect(await readdir(dir)).toEqual([`${today()}.log`]);
        const records = await readRecords(join(dir, `${today()}.log`));
        expect(records.map((record) => record.source)).toEqual(['main:chat', 'app:remote-shell']);
        expect(records[0]).toMatchObject({
            level: 'info',
            msg: '窗口已创建',
            data: { variant: 'lab' },
        });
        expect(records[1]).toMatchObject({ level: 'warn', msg: '连接断开' });
        // at 是事件发生那一刻（不是 flush 那一刻）
        expect(records[0]?.at).toBe(new Date(T0).toISOString());
    });

    it('T2 级别过滤：level=warn 时 debug / info 不落盘', async () => {
        const logger = createLogger({ dir, level: 'warn', now });
        const log = logger.child('main:test');
        log.debug('d');
        log.info('i');
        log.warn('w');
        log.error('e');
        await logger.flush();

        const records = await readRecords(join(dir, `${today()}.log`));
        expect(records.map((record) => record.msg)).toEqual(['w', 'e']);
        expect(isLogLevel('warn')).toBe(true);
        expect(isLogLevel('trace')).toBe(false);
    });

    it('T3 无全局单例：两个 logger 各自独立；child 固定 source；traceId 继承', async () => {
        const first = createLogger({ dir: join(dir, 'first'), source: 'root-first', now });
        const second = createLogger({ dir: join(dir, 'second'), source: 'root-second', now });

        first.child('page:chat').withTrace('trace-1').info('a1');
        first.child('page:chat').info('a2');
        second.info('b1');
        await Promise.all([first.flush(), second.flush()]);

        const a = await readRecords(join(dir, 'first', `${today()}.log`));
        const b = await readRecords(join(dir, 'second', `${today()}.log`));
        expect(a.map((record) => record.source)).toEqual(['page:chat', 'page:chat']);
        expect(a[0]?.traceId).toBe('trace-1');
        // child 的 traceId 缺省继承父句柄；没有就不写这个字段
        expect(a[1]?.traceId).toBeUndefined();
        expect(b.map((record) => record.source)).toEqual(['root-second']);
        expect(b[0]?.msg).toBe('b1');
    });

    it('T4 按天：文件名带本地日期，跨天换文件', async () => {
        const logger = createLogger({ dir, now });
        const log = logger.child('main:test');
        const firstDay = today();
        log.info('day-1');
        clock += DAY;
        const secondDay = today();
        log.info('day-2');
        await logger.flush();

        expect(secondDay).not.toBe(firstDay);
        const names = (await readdir(dir)).sort();
        expect(names).toEqual([`${firstDay}.log`, `${secondDay}.log`].sort());
        expect((await readRecords(join(dir, `${firstDay}.log`)))[0]?.msg).toBe('day-1');
        expect((await readRecords(join(dir, `${secondDay}.log`)))[0]?.msg).toBe('day-2');
    });

    it('T5 按大小轮转：滚出 .1 / .2，超 maxFiles 删最旧（判据 4）', async () => {
        const maxBytes = 400;
        const logger = createLogger({ dir, now, rotate: { maxBytes, maxFiles: 2, maxDays: 0 } });
        const log = logger.child('main:rotate');
        const padding = 'x'.repeat(60);
        for (let index = 0; index < 30; index += 1) log.info(`line-${index}`, { padding });
        await logger.flush();

        const base = `${today()}.log`;
        const names = (await readdir(dir)).sort();
        expect(names).toEqual([base, `${base}.1`, `${base}.2`].sort());
        // 超 maxFiles 的最旧一份真的被删了（不会无限长 .3 .4 …）
        expect(names).not.toContain(`${base}.3`);
        // 每份都不超上限（单行小于 maxBytes）
        for (const name of names) {
            expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(maxBytes);
        }
        // 最新一条在当前文件；旧内容已经滚走
        const newest = await readRecords(join(dir, base));
        expect(newest.at(-1)?.msg).toBe('line-29');
        const kept = [
            ...(await readRecords(join(dir, `${base}.2`))),
            ...(await readRecords(join(dir, `${base}.1`))),
            ...newest,
        ];
        expect(kept.length).toBeLessThan(30);
        // 保留的历史按数字越大越旧：.2 的第一条早于 .1 的第一条
        const oldestKept = (await readRecords(join(dir, `${base}.2`)))[0];
        const newerKept = (await readRecords(join(dir, `${base}.1`)))[0];
        expect(Number(oldestKept?.msg.split('-')[1])).toBeLessThan(Number(newerKept?.msg.split('-')[1]));
    });

    it('T6 重开续写：同一天接着原文件写，按已有大小判轮转', async () => {
        const rotate = { maxBytes: 1000, maxFiles: 3, maxDays: 0 };
        const first = createLogger({ dir, now, rotate });
        first.child('main:test').info('a', { padding: 'x'.repeat(280) });
        await first.close();

        const second = createLogger({ dir, now, rotate });
        second.child('main:test').info('b', { padding: 'y'.repeat(280) });
        await second.close();

        const base = `${today()}.log`;
        expect(await readdir(dir)).toEqual([base]);
        const records = await readRecords(join(dir, base));
        expect(records.map((record) => record.msg)).toEqual(['a', 'b']);

        // 再写一条：新 logger 认得已有大小（两条 ~740B），越过 maxBytes ⇒ 会轮转
        const third = createLogger({ dir, now, rotate });
        third.child('main:test').info('c', { padding: 'z'.repeat(280) });
        await third.close();
        expect((await readdir(dir)).sort()).toEqual([base, `${base}.1`].sort());
        expect((await readRecords(join(dir, base))).map((record) => record.msg)).toEqual(['c']);
        expect((await readRecords(join(dir, `${base}.1`))).map((record) => record.msg)).toEqual(['a', 'b']);
    });

    it('T7 data 有界：大对象截成 {truncated,bytes}；循环引用不崩', async () => {
        const logger = createLogger({ dir, now, maxDataBytes: 200 });
        const log = logger.child('main:test');
        log.info('big', { payload: 'x'.repeat(5000) });
        log.info('small', { user: 'u1' });
        const cyclic: Record<string, unknown> = { name: 'c' };
        cyclic['self'] = cyclic;
        log.info('cycle', cyclic);
        await logger.flush();

        const records = await readRecords(join(dir, `${today()}.log`));
        expect(records[0]?.data).toMatchObject({ truncated: true });
        expect(Number(records[0]?.data?.['bytes'])).toBeGreaterThan(200);
        expect(records[1]?.data).toEqual({ user: 'u1' });
        expect(records[2]?.data).toEqual({ name: 'c', self: '[circular]' });
        // 整行也不会爆（有界化之后远低于单条记录上限）
        for (const record of records) expect(JSON.stringify(record).length).toBeLessThan(2000);
    });

    it('T8 err 带栈：Error / 非 Error / cause 都有形状', async () => {
        const logger = createLogger({ dir, now });
        const log = logger.child('main:test');
        const cause = new Error('root');
        log.error('failed', { provider: 'x' }, new Error('boom', { cause }));
        log.error('plain', undefined, 'just-a-string');
        await logger.flush();

        const records = await readRecords(join(dir, `${today()}.log`));
        expect(records[0]?.err).toMatchObject({ name: 'Error', message: 'boom', cause: 'Error: root' });
        expect(records[0]?.err?.stack).toContain('boom');
        expect(records[1]?.err).toMatchObject({ name: 'NonError', message: 'just-a-string' });
    });

    it('T9 配置错误带 code；close 之后不再写', async () => {
        expect(() => createLogger({ dir: '' })).toThrow(LogError);
        expect(() => createLogger({ dir, level: 'trace' as never })).toThrow(/log\/invalid-options/);
        const logger = createLogger({ dir, now });
        expect(() => logger.child('')).toThrow(/log\/invalid-source/);

        const log = logger.child('main:test');
        log.info('before-close');
        await logger.close();
        log.info('after-close');
        await logger.flush();
        const records = await readRecords(join(dir, `${today()}.log`));
        expect(records.map((record) => record.msg)).toEqual(['before-close']);
    });

    it('T10 按天清理：超过 maxDays 的旧日期组（含 .N）被删，今天与窗口内的留', async () => {
        await mkdir(dir, { recursive: true });
        const stale = ['2026-10-01.log', '2026-10-01.log.1', '2026-10-03.log.2'];
        const fresh = ['2026-10-20.log', `${today()}.log`];
        for (const name of [...stale, ...fresh]) await writeFile(join(dir, name), '', 'utf8');

        // 今天 2026-10-31，maxDays=14 ⇒ 保留 10-18 起
        const logger = createLogger({ dir, now, rotate: { maxDays: 14, maxBytes: 0 } });
        logger.child('main:test').info('x');
        await logger.flush();

        const names = await readdir(dir);
        for (const name of stale) expect(names).not.toContain(name);
        for (const name of fresh) expect(names).toContain(name);
        expect(await readRecords(join(dir, `${today()}.log`))).toHaveLength(1);
    });

    it('T11 写盘失败不抛（日志是旁路），走 onError', async () => {
        const blocker = join(dir, 'not-a-dir');
        await writeFile(blocker, 'file', 'utf8');
        const errors: unknown[] = [];
        const logger = createLogger({ dir: blocker, now, onError: (error) => errors.push(error) });
        expect(() => logger.child('main:test').info('x')).not.toThrow();
        await logger.flush();
        expect(errors.length).toBeGreaterThan(0);
    });
});
