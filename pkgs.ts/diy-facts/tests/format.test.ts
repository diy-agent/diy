// tests/format.test.ts — `format` 字段（##5 第 12 轮 2：value 的类型住哪）
//
// 三条判据：
//   ① 缺省 md **不落盘**（省字节，免全库迁移）—— 写了 `format: md` 也归一成不写
//   ② `format: json` 在 submit 当场 JSON.parse，写错逗号即拒（错误码 facts/value-format）
//   ③ 非法 format 值走 schema 报错，不是静默忽略（拼错 format 名 = 永远校验不上）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateFacts } from '../src/validate';
import { loadRepo, renderDoc, submit } from '../src/node/index';
import type { Fact } from '../src/types';

const tmp: string[] = [];
afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'facts-fmt-'));
    tmp.push(root);
    const dir = path.join(root, 'knowledge');
    mkdirSync(path.join(dir, 'facts'), { recursive: true });
    writeFileSync(path.join(dir, 'subjects.yaml'), 'subjects:\n  app.port:\n    description: 端口\n');
    // 证据要指得到真文件（G4 会校验），造一个
    writeFileSync(path.join(dir, '..', 'K.ts'), '// x\n');
    return dir;
}

const base = { subject: 'app.port', aspect: 'default', evidence: { source: 'code' as const, at: 'K.ts:1' } };

describe('format', () => {
    it('json 值能被解析 → ok，非法 JSON → facts/value-format', () => {
        const good = validateFacts([{ ...base, id: 'a', value: '{"port":18888}', format: 'json' }]);
        expect(good.issues).toEqual([]);
        expect(good.facts[0]!.format).toBe('json');

        const bad = validateFacts([{ ...base, id: 'b', value: '{"port":18888,}', format: 'json' }]);
        expect(bad.issues.map((i) => i.code)).toContain('facts/value-format');
        expect(bad.facts).toEqual([]);
    });

    it('未知 format 名 → schema 报错（不是静默当 md）', () => {
        const r = validateFacts([{ ...base, id: 'c', value: 'x', format: 'yaml' }]);
        expect(r.issues.map((i) => i.code)).toContain('facts/schema');
        expect(r.issues[0]!.detail).toContain('md | json');
    });

    it('缺省 md 不落盘；json 落盘并可读回', () => {
        const dir = makeRepo();
        const f = (id: string, value: string, format?: 'json'): Fact => ({
            id,
            subject: 'app.port',
            aspect: id === 'md' ? 'default' : 'contract',
            value,
            ...(format === undefined ? {} : { format }),
            review: 'accepted',
            lifecycle: 'active',
            evidence: { source: 'code', at: 'K.ts:1' },
        });
        writeFileSync(path.join(dir, 'facts', 'app.yaml'), renderDoc({ domain: 'app', note: '', facts: [] }));
        const report = submit(dir, { facts: [f('md', '散文'), f('json', '{"a":1}', 'json')] });
        expect(report.problems).toEqual([]);
        const text = readFileSync(path.join(dir, 'facts', 'app.yaml'), 'utf8');
        expect(text.match(/format:/g)?.length).toBe(1); // 只有 json 那条写了
        const repo = loadRepo(dir);
        expect(repo.facts.map((x) => [x.id, x.format]).sort()).toEqual([['json', 'json'], ['md', undefined]]);
    });
});
