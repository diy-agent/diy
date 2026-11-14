// mapping.test.ts —— Astryx 面的纯映射规则（工具行 / 投递状态）。

import { describe, expect, it } from 'vitest';

import type { TimelinePart } from '@diy-agent/chat-core';
import { deliveryFooterOf, deliveryStatusOf, toolTargetOf } from './mapping';

const tool = (args: unknown): TimelinePart & { kind: 'tool' } => ({
    kind: 'tool',
    id: 'tool-1',
    name: 'bash',
    args,
    state: 'ok',
});

describe('toolTargetOf', () => {
    it('bash 只取首段命令', () => {
        expect(toolTargetOf(tool({ command: 'rg foo src && head -3 x && echo ok' }))).toBe('rg foo src');
    });

    it('文件工具只取文件名', () => {
        expect(toolTargetOf(tool({ path: '/Users/ccc/git/diy/diy/src/a.ts' }))).toBe('a.ts');
    });

    it('过长的目标截断到 60 字符以内', () => {
        const out = toolTargetOf(tool({ command: `echo ${'x'.repeat(200)}` }))!;
        expect(out.length).toBeLessThanOrEqual(60);
        expect(out.endsWith('…')).toBe(true);
    });
});

describe('delivery 状态', () => {
    it('queued/delivering 不算错误（执行中另有指示器）', () => {
        expect(deliveryStatusOf([{ botId: 'b', name: 'diy', color: '#000', state: 'delivering' }])).toBeUndefined();
        expect(deliveryFooterOf([{ botId: 'b', name: 'diy', color: '#000', state: 'queued' }])).toBeUndefined();
    });

    it('失败才出状态与文案', () => {
        const failed = [{ botId: 'b', name: 'diy', color: '#000', state: 'failed' as const }];
        expect(deliveryStatusOf(failed)).toBe('error');
        expect(deliveryFooterOf(failed)).toBe('diy 未送达');
    });
});
