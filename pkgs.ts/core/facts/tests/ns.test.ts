import { describe, expect, it } from 'vitest';
import { formatGid, formatNs, nsRank, parseGid, parseNs, resolveRef, sameNs, type Ns } from '../src/ns';

const TASK: Ns = { kind: 'task', taskUri: 'projects/4/tasks/404' };

describe('parseNs', () => {
    it('三种合法形状', () => {
        expect(parseNs('global')).toEqual({ ok: true, value: { kind: 'global' } });
        expect(parseNs('project')).toEqual({ ok: true, value: { kind: 'project' } });
        expect(parseNs('task:projects/4/tasks/404')).toEqual({ ok: true, value: TASK });
    });

    it('拒绝短形 task id（tid 跨项目重复 13 个，实测）', () => {
        const r = parseNs('task:4/404');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('facts/ns-invalid');
    });

    it('拒绝未知命名空间', () => {
        const r = parseNs('repo:foo');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('facts/ns-invalid');
    });
});

describe('formatNs / sameNs', () => {
    it('往返', () => {
        for (const ns of [{ kind: 'global' }, { kind: 'project' }, TASK] as Ns[]) {
            const r = parseNs(formatNs(ns));
            expect(r.ok && sameNs(r.value, ns)).toBe(true);
        }
    });
});

describe('parseGid', () => {
    it('global / project', () => {
        expect(parseGid('global:app.port#default')).toEqual({
            ok: true,
            value: { ns: { kind: 'global' }, claim: 'app.port#default' },
        });
        const p = parseGid('project:model.default#fallback');
        expect(p.ok && p.value.ns.kind).toBe('project');
    });

    it('task：ns 与 claim 的分界是最后一个冒号', () => {
        const r = parseGid('task:projects/4/tasks/404:dev.check#entry');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.ns).toEqual(TASK);
            expect(r.value.claim).toBe('dev.check#entry');
        }
    });

    it('无前缀 = 报错（不做"当前库"推导）', () => {
        const r = parseGid('app.port#default');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('facts/ns-invalid');
    });

    it('claim 形状非法（缺 aspect / 含空格）', () => {
        for (const bad of ['project:app.port', 'project:app port#default', 'project:app.port#']) {
            expect(parseGid(bad).ok).toBe(false);
        }
    });
});

describe('resolveRef（同库短写）', () => {
    it('不含冒号 = 本库', () => {
        const r = resolveRef('app.port#default', TASK);
        expect(r).toEqual({ ok: true, value: { ns: TASK, claim: 'app.port#default' } });
    });

    it('含冒号 = 全 gid（跨库引用）', () => {
        const r = resolveRef('project:app.port#default', TASK);
        expect(r.ok && r.value.ns.kind).toBe('project');
    });
});

describe('nsRank', () => {
    it('任务 > 项目 > 全局', () => {
        expect(nsRank(TASK)).toBeLessThan(nsRank({ kind: 'project' }));
        expect(nsRank({ kind: 'project' })).toBeLessThan(nsRank({ kind: 'global' }));
    });
});

describe('formatGid', () => {
    it('与 parseGid 互逆', () => {
        const gid = formatGid(TASK, 'dev.check#entry');
        expect(gid).toBe('task:projects/4/tasks/404:dev.check#entry');
        const r = parseGid(gid);
        expect(r.ok && r.value.claim).toBe('dev.check#entry');
    });
});
