// tests/node.test.ts — 存储层（load / check / submit）的判据
//
// 压的是**真场景**而不是构造的空库：词表 → 提交两条 → 改一条 → 提交一条冲突的。
// 每条都在临时目录里跑（submit 真的落盘，不 mock fs —— mock 出来的通过等于没验）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRepo, FactsRepoError, loadRepo, renderDoc, submit } from '../src/node/index';
import type { Fact } from '../src/types';

const tmp: string[] = [];
function makeRepo(files: Record<string, string> = {}): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'facts-'));
    tmp.push(root);
    const dir = path.join(root, 'knowledge');
    mkdirp(path.join(dir, 'facts'));
    writeFileSync(
        path.join(dir, 'subjects.yaml'),
        'subjects:\n  app.port:\n    description: 应用监听端口\n  dev.check:\n    description: 提交前检查\n',
    );
    const base: Record<string, string> = {
        'app.yaml': 'domain: app\nfacts: []\n',
        ...files,
    };
    for (const [name, text] of Object.entries(base)) writeFileSync(path.join(dir, 'facts', name), text);
    return dir;
}
function mkdirp(p: string): void {
    mkdirSync(p, { recursive: true });
}
afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fact(over: Partial<Fact> & { id: string; subject: string; aspect: string; value: string }): Fact {
    return {
        review: 'accepted',
        lifecycle: 'active',
        evidence: { source: 'code', at: 'README.md:1', verifiedAt: '2026-10-21' },
        ...over,
    } as Fact;
}

describe('loadRepo / checkRepo', () => {
    it('目录不存在 = 环境问题，不静默当空库', () => {
        expect(() => loadRepo('/nonexistent/knowledge')).toThrow(FactsRepoError);
    });

    it('证据指向的文件不存在 → error（G4）', () => {
        const dir = makeRepo({
            'app.yaml': `domain: app\nfacts:\n  - id: a\n    subject: app.port\n    aspect: default\n    value: '1'\n    review: accepted\n    lifecycle: active\n    evidence: { source: code, at: nope.ts:3 }\n`,
        });
        writeFileSync(path.join(dir, '..', 'README.md'), 'x\n');
        const { problems } = checkRepo(dir);
        expect(problems.map((p) => p.code)).toContain('facts/evidence-missing');
    });

    it('未登记 subject → error（G3）', () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'facts-'));
        tmp.push(root);
        writeFileSync(path.join(root, 'K.ts'), 'a\nb\nc\n');
        const dir = path.join(root, 'knowledge');
        mkdirp(path.join(dir, 'facts'));
        writeFileSync(path.join(dir, 'subjects.yaml'), 'subjects: {}\n');
        writeFileSync(
            path.join(dir, 'facts', 'x.yaml'),
            `domain: x\nfacts:\n  - id: a\n    subject: 端口\n    aspect: default\n    value: '1'\n    review: accepted\n    lifecycle: active\n    evidence: { source: user, at: K.ts:2 }\n`,
        );
        expect(checkRepo(dir).problems.map((p) => p.code)).toContain('facts/subject-unregistered');
    });
});

describe('submit（整批事务）', () => {
    it('写入后能原样读回（roundtrip），字段顺序稳定', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\nb\nc\n');
        const { report } = submit(dir, {
            facts: [fact({ id: 'port.1', subject: 'app.port', aspect: 'default', value: '18888', evidence: { source: 'code', at: 'K.ts:2', verifiedAt: '2026-10-21' } })],
        });
        expect(report.added).toEqual(['port.1']);
        const back = loadRepo(dir).facts;
        expect(back.map((f) => `${f.id}=${f.value}`)).toEqual(['port.1=18888']);
        const text = readFileSync(path.join(dir, 'facts', 'app.yaml'), 'utf8');
        // 头注由 note 生成 + 条目字段顺序固化
        expect(text.startsWith('# knowledge/facts/app.yaml')).toBe(true);
        expect(text.indexOf('id: port.1') < text.indexOf('subject: app.port')).toBe(true);
    });

    it('改同一条 = 覆盖（审计锚点稳定），重复提交同一份 = unchanged', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\nb\nc\n');
        const one = fact({ id: 'port.1', subject: 'app.port', aspect: 'default', value: '18888', evidence: { source: 'code', at: 'K.ts:2', verifiedAt: '2026-10-21' } });
        submit(dir, { facts: [one] });
        const again = submit(dir, { facts: [one] });
        expect(again.report.unchanged).toEqual(['port.1']);
        const moved = submit(dir, { facts: [{ ...one, value: '0' }] });
        expect(moved.report.updated.map((u) => u.id)).toEqual(['port.1']);
        expect(loadRepo(dir).facts[0]?.value).toBe('0');
    });

    it('候选集有冲突 → 整批拒（磁盘不动）', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\nb\nc\n');
        const a = fact({ id: 'port.a', subject: 'app.port', aspect: 'default', value: '18888', evidence: { source: 'code', at: 'K.ts:2', verifiedAt: '2026-10-21' } });
        submit(dir, { facts: [a] });
        const before = readFileSync(path.join(dir, 'facts', 'app.yaml'), 'utf8');
        const bad = submit(dir, { facts: [fact({ id: 'port.b', subject: 'app.port', aspect: 'default', value: '4000', evidence: { source: 'code', at: 'K.ts:2', verifiedAt: '2026-10-21' } })] });
        expect(bad.problems.map((p) => p.code)).toContain('facts/scope-conflict');
        expect(readFileSync(path.join(dir, 'facts', 'app.yaml'), 'utf8')).toBe(before);
    });

    it('--dry-run 只算不写', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\nb\nc\n');
        const r = submit(dir, {
            dryRun: true,
            facts: [fact({ id: 'port.1', subject: 'app.port', aspect: 'default', value: '18888', evidence: { source: 'code', at: 'K.ts:2', verifiedAt: '2026-10-21' } })],
        });
        expect(r.report.added).toEqual(['port.1']);
        expect(loadRepo(dir).facts).toEqual([]);
    });

    it('词表扩展与事实同一事务：新 subject 一次带上', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\nb\nc\n');
        const r = submit(dir, {
            facts: [fact({ id: 'n.1', subject: 'new.thing', aspect: 'v', value: 'x', evidence: { source: 'code', at: 'K.ts:2', verifiedAt: '2026-10-21' } })],
            subjects: [{ key: 'new.thing', description: '新对象' }],
        });
        expect(r.problems.filter((p) => p.level === 'error')).toEqual([]);
        expect(r.report.newSubjects).toEqual(['new.thing']);
        expect(loadRepo(dir).subjects.map((s) => s.key)).toContain('new.thing');
    });

    it('新 subject 缺 description → 拒（词表没描述等于没词表）', () => {
        const dir = makeRepo();
        const r = submit(dir, { facts: [], subjects: [{ key: 'z.z' }] });
        expect(r.problems.map((p) => p.code)).toContain('facts/subject-no-desc');
    });
});

describe('renderDoc', () => {
    it('条目按 claim 排序（diff 只落在改动的那条）', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\nb\nc\n');
        const mk = (id: string, subject: string, aspect: string): Fact =>
            fact({ id, subject, aspect, value: 'v', evidence: { source: 'code', at: 'K.ts:2', verifiedAt: '2026-10-21' } });
        const text = renderDoc({ domain: 'app', note: 'n', facts: [mk('b', 'app.port', 'resolution'), mk('a', 'app.port', 'default'), mk('c', 'app.env', 'values')] });
        // 期望顺序：app.env#values(c) → app.port#default(a) → app.port#resolution(b)
        const [pc, pa, pb] = [text.indexOf('id: c'), text.indexOf('id: a'), text.indexOf('id: b')];
        expect(pc).toBeGreaterThanOrEqual(0);
        expect(pc).toBeLessThan(pa);
        expect(pa).toBeLessThan(pb);
    });
});
