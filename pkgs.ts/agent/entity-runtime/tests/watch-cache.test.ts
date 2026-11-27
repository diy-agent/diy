import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { clearWatchCache, watchedValue } from '../src/watch-cache';

const dirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'watch-cache-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    clearWatchCache();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

describe('watchedValue：provider 自己的缓存', () => {
    it('同一个 key 只算一次；clear 后重算', () => {
        const dir = tmp();
        let calls = 0;
        const value = watchedValue(
            `t:${dir}`,
            [dir],
            () => {
                calls += 1;
                return calls;
            },
            { recursive: true },
        );
        expect(value()).toBe(1);
        expect(value()).toBe(1);
        expect(calls).toBe(1);
        clearWatchCache();
        expect(value()).toBe(2);
    });

    it('watch 到文件变化后重算（macOS recursive watch）', async () => {
        const dir = tmp();
        writeFileSync(join(dir, 'a.md'), 'one');
        let calls = 0;
        const value = watchedValue(
            `t2:${dir}`,
            [dir],
            () => {
                calls += 1;
                return calls;
            },
            { recursive: true },
        );
        expect(value()).toBe(1);
        writeFileSync(join(dir, 'a.md'), 'two');
        await sleep(120);
        expect(value()).toBeGreaterThanOrEqual(2);
    });

    it('没有可 watch 的路径 ⇒ 不缓存（安全退化）', () => {
        const missing = join(tmp(), 'nope');
        let calls = 0;
        const value = watchedValue(`t3:${missing}`, [missing], () => {
            calls += 1;
            return calls;
        });
        expect(value()).toBe(1);
        expect(value()).toBe(2);
    });
});
