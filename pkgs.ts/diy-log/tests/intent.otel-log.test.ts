// tests/intent.otel-log.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 @diy-agent/log「意图测试」—— OTel 日志 API + 文件导出器（##482 判据）
//
//   T1  统一流：不同 source 写进**同一份文件**，靠 source 字段过滤
//   T2  级别过滤：provider 的 minimumSeverity 生效（debug 不落盘）
//   T3  无全局单例：两个 provider / 目录各自独立；child 固定 source
//   T4  按天：文件名带本地日期，跨天换文件（记录时间，不是 export 时刻）
//   T5  按大小轮转：超 maxBytes 滚 `.1` `.2`，超 maxFiles 删最旧（判据 4 实测）
//   T6  重开续写：同一天新建导出器接着原文件写，按已有大小判轮转
//   T7  data 有界：大对象截成 `{truncated,bytes}`，循环引用不崩
//   T8  err 带栈：Error / 非 Error / cause 都有形状
//   T9  配置错误带 code；shutdown 之后 export 回调 FAILED
//   T10 按天清理：超过 maxDays 的旧日期组被删
//   T11 写盘失败不抛（日志是旁路），走 onError + resultCallback(FAILED)
//   T12 trace 关联：活动 span ⇒ trace_id / span_id 写进记录（判据 5）
//   T13 不自研接口 / 业务包不 import OTel SDK 包（判据 1 / 2 的静态断言）
//
// 真文件系统（临时目录），不 mock fs —— 这层要验的就是落盘行为本身。
// ═══════════════════════════════════════════════════════════════

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, SeverityNumber as ApiSeverityNumber, TraceFlags, trace, type Span } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { child, FileLogRecordExporter, LogError, type ExportedLogRecord, type FileLogEntry } from '../src/index.js';

let dir: string;
let providers: LoggerProvider[];

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diy-log-'));
    providers = [];
});

afterEach(async () => {
    for (const provider of providers) await provider.shutdown();
    await rm(dir, { recursive: true, force: true });
});

/** 本地日期键（与被测实现分开算：测试要有自己的期望，不能复用同一段代码） */
function dayName(date: Date): string {
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const TODAY = new Date(2026, 9, 31, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const today = dayName(TODAY);

async function readEntries(file: string): Promise<FileLogEntry[]> {
    const text = await readFile(file, 'utf8');
    if (text.trim() === '') return [];
    return text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as FileLogEntry);
}

interface ProviderOptions {
    maxBytes?: number;
    maxFiles?: number;
    maxDays?: number;
    maxDataBytes?: number;
    minimumSeverity?: SeverityNumber;
    onError?: (error: unknown) => void;
}

/** 真 OTel provider + 真导出器（SimpleLogRecordProcessor：emit 即导出，测试不等批） */
function makeProvider(
    target: string,
    options: ProviderOptions = {},
): { provider: LoggerProvider; exporter: FileLogRecordExporter } {
    const exporter = new FileLogRecordExporter({
        dir: target,
        rotate: { maxBytes: options.maxBytes, maxFiles: options.maxFiles, maxDays: options.maxDays },
        maxDataBytes: options.maxDataBytes,
        onError: options.onError,
    });
    const minimumSeverity = options.minimumSeverity ?? SeverityNumber.DEBUG;
    const provider = new LoggerProvider({
        processors: [new SimpleLogRecordProcessor({ exporter })],
        loggerConfigurator: () => ({ enabled: true, minimumSeverity, traceBased: false }),
    });
    providers.push(provider);
    return { provider, exporter };
}

/** 造一条 OTel 形状的记录（直接喂导出器，用于按天 / 轮转这类要精确控制时间的用例） */
function recordAt(at: Date, msg: string, extra: Partial<ExportedLogRecord> = {}): ExportedLogRecord {
    const millis = at.getTime();
    return {
        hrTime: [Math.floor(millis / 1000), (millis % 1000) * 1_000_000],
        severityNumber: SeverityNumber.INFO,
        severityText: 'info',
        body: msg,
        attributes: {},
        instrumentationScope: { name: 'main:test' },
        ...extra,
    };
}

function exportResult(exporter: FileLogRecordExporter, records: ExportedLogRecord[]): Promise<number> {
    return new Promise((resolve) => exporter.export(records, (result) => resolve(result.code)));
}

/** SimpleLogRecordProcessor 的 forceFlush 不跟踪同步 resource 的导出，故导出器也要 flush */
async function flush(provider: LoggerProvider, exporter: FileLogRecordExporter): Promise<void> {
    await provider.forceFlush();
    await exporter.forceFlush();
}

describe('@diy-agent/log（OTel + 文件导出器）', () => {
    it('T1 统一流：不同 source 写同一份文件，靠 source 过滤', async () => {
        const { provider, exporter } = makeProvider(dir);
        child('main:chat', provider).info('窗口已创建', { variant: 'lab' });
        child('page:chat', provider).warn('未选中会话');
        await flush(provider, exporter);

        expect(await readdir(dir)).toEqual([`${today}.log`]);
        const entries = await readEntries(join(dir, `${today}.log`));
        expect(entries.map((entry) => entry.source)).toEqual(['main:chat', 'page:chat']);
        expect(entries[0]).toMatchObject({ level: 'info', msg: '窗口已创建', data: { variant: 'lab' } });
        expect(entries[1]).toMatchObject({ level: 'warn', msg: '未选中会话' });
        expect(entries[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('T2 级别过滤：minimumSeverity 生效，debug 不落盘', async () => {
        const { provider, exporter } = makeProvider(dir, { minimumSeverity: SeverityNumber.WARN });
        const log = child('main:test', provider);
        log.debug('d');
        log.info('i');
        log.warn('w');
        log.error('e');
        await flush(provider, exporter);

        const entries = await readEntries(join(dir, `${today}.log`));
        expect(entries.map((entry) => entry.msg)).toEqual(['w', 'e']);
    });

    it('T3 无全局单例：两个 provider / 目录各自独立；child 固定 source', async () => {
        const first = makeProvider(join(dir, 'first'));
        const second = makeProvider(join(dir, 'second'));
        child('page:chat', first.provider).info('a1');
        second.provider.getLogger('main:other').emit({
            severityNumber: SeverityNumber.INFO,
            severityText: 'info',
            body: 'b1',
        });
        await Promise.all([flush(first.provider, first.exporter), flush(second.provider, second.exporter)]);

        const a = await readEntries(join(dir, 'first', `${today}.log`));
        const b = await readEntries(join(dir, 'second', `${today}.log`));
        expect(a.map((entry) => entry.source)).toEqual(['page:chat']);
        expect(b.map((entry) => entry.source)).toEqual(['main:other']);
        expect(a[0]?.msg).toBe('a1');
        expect(b[0]?.msg).toBe('b1');
    });

    it('T4 按天：文件名带本地日期，跨天换文件（按记录时间）', async () => {
        const { exporter } = makeProvider(dir);
        const tomorrow = new Date(TODAY.getTime() + DAY);
        await exportResult(exporter, [recordAt(TODAY, 'day-1')]);
        await exportResult(exporter, [recordAt(tomorrow, 'day-2')]);

        const names = (await readdir(dir)).sort();
        expect(names).toEqual([`${today}.log`, `${dayName(tomorrow)}.log`].sort());
        expect((await readEntries(join(dir, `${today}.log`)))[0]?.msg).toBe('day-1');
        expect((await readEntries(join(dir, `${dayName(tomorrow)}.log`)))[0]?.msg).toBe('day-2');
    });

    it('T5 按大小轮转：滚出 .1 / .2，超 maxFiles 删最旧（判据 4）', async () => {
        const maxBytes = 400;
        const { exporter } = makeProvider(dir, { maxBytes, maxFiles: 2, maxDays: 0 });
        const padding = 'x'.repeat(60);
        for (let index = 0; index < 30; index += 1) {
            await exportResult(exporter, [
                recordAt(TODAY, `line-${index}`, { attributes: { padding } }),
            ]);
        }

        const base = `${today}.log`;
        const names = (await readdir(dir)).sort();
        expect(names).toEqual([base, `${base}.1`, `${base}.2`].sort());
        // 超 maxFiles 的最旧一份真的被删了（不会无限长 .3 .4 …）
        expect(names).not.toContain(`${base}.3`);
        // 每份都不超上限
        for (const name of names) {
            expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(maxBytes);
        }
        // 最新一条在当前文件；保留的历史按数字越大越旧
        const newest = await readEntries(join(dir, base));
        expect(newest.at(-1)?.msg).toBe('line-29');
        const oldestKept = (await readEntries(join(dir, `${base}.2`)))[0];
        const newerKept = (await readEntries(join(dir, `${base}.1`)))[0];
        expect(Number(oldestKept?.msg.split('-')[1])).toBeLessThan(Number(newerKept?.msg.split('-')[1]));
    });

    it('T6 重开续写：同一天接着原文件写，按已有大小判轮转', async () => {
        const rotate = { maxBytes: 1000, maxFiles: 3, maxDays: 0 };
        const base = `${today}.log`;
        const first = new FileLogRecordExporter({ dir, rotate });
        await exportResult(first, [recordAt(TODAY, 'a', { attributes: { padding: 'x'.repeat(280) } })]);
        await first.shutdown();

        const second = new FileLogRecordExporter({ dir, rotate });
        await exportResult(second, [recordAt(TODAY, 'b', { attributes: { padding: 'y'.repeat(280) } })]);
        await second.shutdown();
        expect(await readdir(dir)).toEqual([base]);
        expect((await readEntries(join(dir, base))).map((entry) => entry.msg)).toEqual(['a', 'b']);

        // 再写一条：新导出器认得已有大小（两条 ~740B），越过 maxBytes ⇒ 会轮转
        const third = new FileLogRecordExporter({ dir, rotate });
        await exportResult(third, [recordAt(TODAY, 'c', { attributes: { padding: 'z'.repeat(280) } })]);
        await third.shutdown();
        expect((await readdir(dir)).sort()).toEqual([base, `${base}.1`].sort());
        expect((await readEntries(join(dir, base))).map((entry) => entry.msg)).toEqual(['c']);
        expect((await readEntries(join(dir, `${base}.1`))).map((entry) => entry.msg)).toEqual(['a', 'b']);
    });

    it('T7 data 有界：大对象截成 {truncated,bytes}；循环引用不崩', async () => {
        const { provider, exporter } = makeProvider(dir, { maxDataBytes: 200 });
        const log = child('main:test', provider);
        log.info('big', { payload: 'x'.repeat(5000) });
        log.info('small', { user: 'u1' });
        const cyclic: Record<string, unknown> = { name: 'c' };
        cyclic['self'] = cyclic;
        log.info('cycle', cyclic);
        await flush(provider, exporter);

        const entries = await readEntries(join(dir, `${today}.log`));
        expect(entries[0]?.data).toMatchObject({ truncated: true });
        expect(Number(entries[0]?.data?.['bytes'])).toBeGreaterThan(200);
        expect(entries[1]?.data).toEqual({ user: 'u1' });
        expect(entries[2]?.data).toEqual({ name: 'c', self: '[circular]' });
        for (const entry of entries) expect(JSON.stringify(entry).length).toBeLessThan(2000);
    });

    it('T8 err 带栈：Error / 非 Error / cause 都有形状', async () => {
        const { provider, exporter } = makeProvider(dir);
        const log = child('main:test', provider);
        log.error('failed', { provider: 'x' }, new Error('boom', { cause: new Error('root') }));
        log.error('plain', undefined, 'just-a-string');
        await flush(provider, exporter);

        const entries = await readEntries(join(dir, `${today}.log`));
        expect(entries[0]?.err).toMatchObject({ name: 'Error', message: 'boom', cause: 'Error: root' });
        expect(entries[0]?.err?.stack).toContain('boom');
        expect(entries[0]?.data).toEqual({ provider: 'x' });
        expect(entries[1]?.err).toMatchObject({ name: 'NonError', message: 'just-a-string' });
    });

    it('T9 配置错误带 code；shutdown 之后 export 回调 FAILED', async () => {
        expect(() => new FileLogRecordExporter({ dir: '' })).toThrow(LogError);
        expect(() => new FileLogRecordExporter({ dir, maxDataBytes: 0 })).toThrow(/log\/invalid-options/);
        expect(() => child('')).toThrow(/log\/invalid-source/);

        const exporter = new FileLogRecordExporter({ dir });
        await exporter.shutdown();
        const code = await exportResult(exporter, [recordAt(TODAY, 'after-shutdown')]);
        expect(code).toBe(1);
        expect(await readdir(dir)).toEqual([]);
    });

    it('T10 按天清理：超过 maxDays 的旧日期组（含 .N）被删，今天与窗口内的留', async () => {
        await mkdir(dir, { recursive: true });
        const stale = ['2026-10-01.log', '2026-10-01.log.1', '2026-10-03.log.2'];
        const fresh = ['2026-10-20.log', `${today}.log`];
        for (const name of [...stale, ...fresh]) await writeFile(join(dir, name), '', 'utf8');

        // 今天 2026-10-31，maxDays=14 ⇒ 保留 10-18 起
        const exporter = new FileLogRecordExporter({ dir, rotate: { maxDays: 14, maxBytes: 0 } });
        await exportResult(exporter, [recordAt(TODAY, 'x')]);

        const names = await readdir(dir);
        for (const name of stale) expect(names).not.toContain(name);
        for (const name of fresh) expect(names).toContain(name);
        expect(await readEntries(join(dir, `${today}.log`))).toHaveLength(1);
    });

    it('T11 写盘失败不抛（日志是旁路），走 onError + resultCallback(FAILED)', async () => {
        const blocker = join(dir, 'not-a-dir');
        await writeFile(blocker, 'file', 'utf8');
        const errors: unknown[] = [];
        const exporter = new FileLogRecordExporter({ dir: blocker, onError: (error) => errors.push(error) });

        const code = await exportResult(exporter, [recordAt(TODAY, 'x')]);
        expect(code).toBe(1);
        expect(errors.length).toBeGreaterThan(0);
    });

    it('T12 trace 关联：活动 span ⇒ trace_id / span_id 写进记录（判据 5）', async () => {
        const { provider, exporter } = makeProvider(dir);
        const traceId = 'a'.repeat(32);
        const spanId = 'b'.repeat(16);
        const fakeSpan = {
            spanContext: () => ({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }),
        } as unknown as Span;
        const spanContext = trace.setSpan(context.active(), fakeSpan);
        const log = child('main:test', provider);

        log.emit({ severityNumber: SeverityNumber.INFO, severityText: 'info', body: 'with-span', context: spanContext });
        log.info('without-span');
        await flush(provider, exporter);

        const entries = await readEntries(join(dir, `${today}.log`));
        expect(entries[0]).toMatchObject({ msg: 'with-span', trace_id: traceId, span_id: spanId });
        expect(entries[1]?.trace_id).toBeUndefined();
        expect(entries[1]?.span_id).toBeUndefined();
        // api 的 SeverityNumber 与本包写出的级别名是同一套语义（防止误用别的包）
        expect(ApiSeverityNumber.INFO).toBe(SeverityNumber.INFO);
    });

    it('T13 判据 1/2 的静态断言：src 里没有自研 Logger 接口，也没有 OTel SDK 包名', async () => {
        const { readdir: readDir, readFile: read } = await import('node:fs/promises');
        const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
        const names = await readDir(srcDir);
        for (const name of names.filter((entry) => entry.endsWith('.ts'))) {
            const text = await read(join(srcDir, name), 'utf8');
            expect(text).not.toContain('interface Logger');
            expect(text).not.toContain('sdk-logs');
        }
    });
});
