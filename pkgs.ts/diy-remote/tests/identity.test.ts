// 实例身份：**id 与 hostname 必须解耦**（##479 判据 5）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ID_FILENAME,
    NAME_FILENAME,
    newInstanceId,
    normalizeDisplayName,
    resolveIdentity,
    type StoredIdentity,
} from '../src/identity.js';
import { ensureIdentity, readStoredIdentity, setDisplayName } from '../src/node/identity.js';

const dirs: string[] = [];
function tempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy-remote-test-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('resolveIdentity', () => {
    it('首次启动生成 id，displayName 取 hostname', () => {
        const store: StoredIdentity = { storedId: null, storedName: null, hostname: 'c-mac.local' };
        const { identity, newId } = resolveIdentity(store, () => 'diy-7f3a2c91');
        expect(identity.id).toBe('diy-7f3a2c91');
        expect(identity.displayName).toBe('c-mac.local');
        expect(newId).toBe('diy-7f3a2c91');
    });

    it('hostname 改了之后 id 不变（判据 5）', () => {
        const first = resolveIdentity({ storedId: null, storedName: null, hostname: 'old-host' }, () => 'diy-aaaaaaaa');
        // 用户改了机器名 → 同一个数据根再启动（storedId 已存在）
        const second = resolveIdentity(
            { storedId: first.identity.id, storedName: null, hostname: 'brand-new-host' },
            () => 'diy-bbbbbbbb',
        );
        expect(second.identity.id).toBe('diy-aaaaaaaa');
        expect(second.identity.displayName).toBe('brand-new-host'); // 名字跟着 hostname，但 id 不跟着
        expect(second.newId).toBeNull(); // 不再生成新 id
    });

    it('用户设过显示名后，hostname 再变也不动名字', () => {
        const { identity } = resolveIdentity(
            { storedId: 'diy-aaaaaaaa', storedName: '服务器 prod', hostname: 'whatever' },
            () => 'diy-bbbbbbbb',
        );
        expect(identity).toEqual({ id: 'diy-aaaaaaaa', displayName: '服务器 prod' });
    });

    it('空/空白文件不算「有值」', () => {
        const { identity, newId } = resolveIdentity(
            { storedId: '  \n', storedName: '\t', hostname: 'host-x' },
            () => 'diy-cccccccc',
        );
        expect(identity.id).toBe('diy-cccccccc');
        expect(identity.displayName).toBe('host-x');
        expect(newId).toBe('diy-cccccccc');
    });

    it('hostname 取不到时给一个稳定兜底名', () => {
        const { identity } = resolveIdentity({ storedId: null, storedName: null, hostname: '' }, () => 'diy-dddddddd');
        expect(identity.displayName).toBe('diy-instance');
    });
});

describe('newInstanceId', () => {
    it('diy- 前缀 + 8 位十六进制', () => {
        expect(newInstanceId(() => '1234abcd-0000-4000-8000-000000000000')).toBe('diy-1234abcd');
    });
    it('每次不同（同一个 uuid 源则相同，说明只取前 8 位）', () => {
        const a = newInstanceId();
        const b = newInstanceId();
        expect(a).toMatch(/^diy-[0-9a-f]{8}$/);
        expect(b).toMatch(/^diy-[0-9a-f]{8}$/);
        expect(a).not.toBe(b);
    });
});

describe('normalizeDisplayName', () => {
    it('去空白；空串 → null', () => {
        expect(normalizeDisplayName('  c-mac 的 lab  ')).toBe('c-mac 的 lab');
        expect(normalizeDisplayName('   ')).toBeNull();
        expect(normalizeDisplayName(null)).toBeNull();
    });
});

describe('ensureIdentity（真落盘）', () => {
    it('首次启动写 instance-id；再启动不再覆盖', () => {
        const home = tempHome();
        const first = ensureIdentity(home, { hostname: 'old-host', generateId: () => 'diy-11112222' });
        expect(first.identity.id).toBe('diy-11112222');
        expect(readFileSync(join(home, ID_FILENAME), 'utf-8').trim()).toBe('diy-11112222');

        const second = ensureIdentity(home, { hostname: 'renamed-host', generateId: () => 'diy-99998888' });
        expect(second.identity.id).toBe('diy-11112222');
        expect(second.identity.displayName).toBe('renamed-host');
        expect(readFileSync(join(home, ID_FILENAME), 'utf-8').trim()).toBe('diy-11112222');
    });

    it('setDisplayName 落 instance-name；清空后回落 hostname', () => {
        const home = tempHome();
        ensureIdentity(home, { hostname: 'host-a', generateId: () => 'diy-33334444' });

        const renamed = setDisplayName(home, '  服务器 prod  ', { hostname: 'host-a' });
        expect(renamed.displayName).toBe('服务器 prod');
        expect(readFileSync(join(home, NAME_FILENAME), 'utf-8').trim()).toBe('服务器 prod');

        const cleared = setDisplayName(home, '', { hostname: 'host-a' });
        expect(cleared.displayName).toBe('host-a');
        expect(readStoredIdentity(home, { hostname: 'host-a' }).storedName).toBeNull();
    });
});
