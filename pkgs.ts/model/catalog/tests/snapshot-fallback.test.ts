// 包内快照兜底：空数据根（没有 data/models.dev.json）也必须能列出标准 provider。
// 这是这一包存在的理由 —— 新 worktree / 新机器第一脚就踩空的问题，锁在这里。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasBundledSnapshot } from '@diy-agent/models-dev-snapshot';
import { describe, expect, it } from 'vitest';
import { availableProviders, snapshotAvailable } from '../src/index.js';

describe('models.dev 包内快照兜底', () => {
    it('快照已由 gen 生成（prepare / prepack 会做）', () => {
        expect(hasBundledSnapshot()).toBe(true);
    });

    it('空数据根照样报「有快照」，且列得出标准 provider', () => {
        const emptyHome = mkdtempSync(join(tmpdir(), 'catalog-empty-home-'));
        expect(snapshotAvailable(emptyHome)).toBe(true);
        const providers = availableProviders(emptyHome, { env: {} });
        expect(providers.length).toBeGreaterThan(100);
        expect(providers.some((provider) => provider.models.length > 10)).toBe(true);
    });
});
