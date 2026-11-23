import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    parseRecord,
    readRecords,
    recordPath,
    registryDir,
    snapshotParents,
    updateRecord,
    writeRecord,
    type InstanceRecord,
} from '../server/registry';

const dirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy2-registry-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
    return {
        pid: 4242,
        app: 'diy2',
        launch: 'lab',
        worktree: '/w',
        name: null,
        mode: 'source',
        port: 5300,
        pingPort: null,
        diyHome: '/w/run/diy2/lab',
        variant: 'lab',
        env: 'development',
        argv: [],
        cwd: '/w',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        parents: [],
        ...overrides,
    };
}

describe('registryDir', () => {
    it('DIY_INSTANCE_REGISTRY > DIY_DEV_HOME/apps；不认 DIY2_*（CLI 会清掉那一族）', () => {
        const withOwn = registryDir({ DIY2_REGISTRY: '/tmp/own' });
        expect(withOwn.endsWith(join('dev', 'apps'))).toBe(true);
        expect(withOwn.startsWith('/tmp/own')).toBe(false);
        expect(registryDir({ DIY_INSTANCE_REGISTRY: '/tmp/shared' })).toBe('/tmp/shared');
        expect(registryDir({ DIY_DEV_HOME: '/tmp/dev' })).toBe('/tmp/dev/apps');
    });
});

describe('parseRecord', () => {
    it('坏形状整条作废（读侧对外人写的文件没有信任基础）', () => {
        expect(parseRecord(null)).toBeNull();
        expect(parseRecord({})).toBeNull();
        expect(parseRecord({ pid: 0, port: null, diyHome: '/x' })).toBeNull();
        // 缺 port 字段（不是 null）= 不合格
        expect(parseRecord({ pid: 12, diyHome: '/x' })).toBeNull();
        expect(parseRecord({ pid: 12, port: 1 })).toBeNull();
    });

    it('老记录缺 app/launch/worktree/name → null，不整体报废', () => {
        const parsed = parseRecord({ pid: 12, port: 18888, diyHome: '/x', variant: 'prod', env: 'production' });
        expect(parsed).not.toBeNull();
        expect(parsed!.app).toBeNull();
        expect(parsed!.launch).toBeNull();
        expect(parsed!.argv).toEqual([]);
    });
});

describe('readRecords', () => {
    it('按 pid 存活过滤，并顺手删死条目', () => {
        const dir = tmp();
        writeRecord(dir, record({ pid: 111 }));
        writeRecord(dir, record({ pid: 222 }));
        const alive = (pid: number) => pid === 111;
        const records = readRecords(dir, alive);
        expect(records.map((rec) => rec.pid)).toEqual([111]);
        expect(readdirSync(dir)).toEqual(['111.json']);
    });

    it('目录不存在 → 空表（第一次跑的正常态）', () => {
        expect(readRecords(join(tmp(), 'nope'))).toEqual([]);
    });

    it('坏 JSON 顺手清掉', () => {
        const dir = tmp();
        writeFileSync(recordPath(dir, 333), '{半截');
        expect(readRecords(dir, () => true)).toEqual([]);
        expect(readdirSync(dir)).toEqual([]);
    });
});

describe('updateRecord', () => {
    it('回填端口；记录不在则什么都不做（不凭空造一条）', () => {
        const dir = tmp();
        writeRecord(dir, record({ pid: 7, port: null }));
        updateRecord(dir, 7, { port: 5310 });
        expect(readRecords(dir, () => true)[0]!.port).toBe(5310);

        updateRecord(dir, 8, { port: 5311 });
        expect(readdirSync(dir)).toEqual(['7.json']);
    });
});

describe('snapshotParents', () => {
    it('逐级上溯到 depth / pid ≤ 1 / 拿不到为止（注入 lookup，不真跑 ps）', () => {
        const table: Record<number, { hop: { pid: number; command: string }; ppid: number }> = {
            100: { hop: { pid: 100, command: 'node dev.ts' }, ppid: 50 },
            50: { hop: { pid: 50, command: 'bash sha.sh' }, ppid: 1 },
        };
        const hops = snapshotParents(100, (pid) => table[pid] ?? null);
        expect(hops.map((hop) => hop.command)).toEqual(['node dev.ts', 'bash sha.sh']);
        expect(snapshotParents(1, (pid) => table[pid] ?? null)).toEqual([]);
    });
});
