// tests/atomic-write.test.ts — 落盘原语的判据（##5 第 11 轮 A）
//
// 压的是「失败时到底发生了什么」，所以每条都在**真盘**上跑（mkdtemp），只用 `FsLike`
// 注入单点故障（第一次 rename 抛 ENOSPC）—— mock 全局 fs 的写法在 isolate:false 下会失效。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realFs, tempPathOf, writeFilesAtomic, type FsLike } from '../src/node/atomic-write';
import { loadRepo, submit } from '../src/node/index';

const tmps: string[] = [];
afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mk(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'facts-atomic-'));
    tmps.push(dir);
    return dir;
}

describe('writeFilesAtomic', () => {
    it('成功：每个文件整体换成新内容，不留 tmp', () => {
        const dir = mk();
        const a = path.join(dir, 'a.yaml');
        const b = path.join(dir, 'b.yaml');
        writeFileSync(a, 'old-a');
        writeFilesAtomic([
            { file: a, text: 'new-a' },
            { file: b, text: 'new-b' },
        ]);
        expect(readFileSync(a, 'utf8')).toBe('new-a');
        expect(readFileSync(b, 'utf8')).toBe('new-b');
        expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
    });

    it('second rename 抛 ENOSPC：目标要么全旧要么全新，绝不半截，且 tmp 全清', () => {
        const dir = mk();
        const a = path.join(dir, 'a.yaml');
        const b = path.join(dir, 'b.yaml');
        writeFileSync(a, 'old-a-longer-content');
        writeFileSync(b, 'old-b');
        let renames = 0;
        const fs: FsLike = {
            ...realFs,
            renameSync: (from, to) => {
                renames += 1;
                if (renames === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                realFs.renameSync(from, to);
            },
        };
        expect(() =>
            writeFilesAtomic(
                [
                    { file: a, text: 'new-a' },
                    { file: b, text: 'new-b' },
                ],
                { fs },
            ),
        ).toThrow(/ENOSPC/);
        // 第一个已完整换新，第二个保持旧 —— 两者都不是半截
        expect(readFileSync(a, 'utf8')).toBe('new-a');
        expect(readFileSync(b, 'utf8')).toBe('old-b');
        expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
    });

    it('写 tmp 阶段就失败（ENOSPC）：一个目标都不动', () => {
        const dir = mk();
        const a = path.join(dir, 'a.yaml');
        writeFileSync(a, 'old-a');
        let writes = 0;
        const fs: FsLike = {
            ...realFs,
            writeFileSync: (p, data, enc) => {
                writes += 1;
                if (writes === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                realFs.writeFileSync(p, data, enc as BufferEncoding);
            },
        };
        expect(() => writeFilesAtomic([{ file: a, text: 'new-a' }, { file: path.join(dir, 'b.yaml'), text: 'new-b' }], { fs })).toThrow(
            /ENOSPC/,
        );
        expect(readFileSync(a, 'utf8')).toBe('old-a');
        expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
    });

    it('tmp 名带 pid + rand 且后缀不是 .yaml（加载侧不会当成一章事实）', () => {
        const t1 = tempPathOf('/x/knowledge/facts/app.yaml');
        const t2 = tempPathOf('/x/knowledge/facts/app.yaml');
        expect(t1).not.toBe(t2);
        expect(t1).toContain(`.tmp-${process.pid}-`);
        expect(t1.endsWith('.yaml')).toBe(false);
    });

    it('目标原有权限位被继承（0600 不被放宽成 0644）', () => {
        const dir = mk();
        const a = path.join(dir, 'a.yaml');
        writeFileSync(a, 'old');
        chmodSync(a, 0o600);
        writeFilesAtomic([{ file: a, text: 'new' }]);
        expect(statSync(a).mode & 0o777).toBe(0o600);
    });
});

describe('submit 的落盘面', () => {
    it('一次提交写多章 + 词表：全成功、无 tmp 残骸、再读回来一致', () => {
        const root = mk();
        const dir = path.join(root, 'knowledge');
        mkdirSync(path.join(dir, 'facts'), { recursive: true });
        writeFileSync(path.join(dir, 'subjects.yaml'), 'subjects:\n  app.port:\n    description: 应用监听端口\n');
        writeFileSync(path.join(dir, 'facts', 'app.yaml'), 'domain: app\nfacts: []\n');
        writeFileSync(path.join(root, 'k.ts'), '// 证据锚点\n');
        const rr = submit(dir, {
            facts: [
                { id: 'app.port.default', subject: 'app.port', aspect: 'default', value: '8080', review: 'accepted', lifecycle: 'active', evidence: { source: 'code', at: 'k.ts:1', verifiedAt: '2026-10-22' } },
                { id: 'app.port.host', subject: 'app.port', aspect: 'host', value: 'localhost', review: 'accepted', lifecycle: 'active', evidence: { source: 'code', at: 'k.ts:1', verifiedAt: '2026-10-22' } },
            ],
            subjects: [{ key: 'app.port', description: '应用监听端口' }],
        });
        expect(rr.problems).toEqual([]);
        expect(readdirSync(path.join(dir, 'facts')).filter((n) => n.includes('.tmp-'))).toEqual([]);
        const repo = loadRepo(dir);
        expect(repo.facts.length).toBe(2);
    });
});
