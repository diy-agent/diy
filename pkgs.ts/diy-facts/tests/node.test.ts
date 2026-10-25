// tests/node.test.ts — 存储层（load / check / submit）的判据
//
// 压的是**真场景**而不是构造的空库：词表 → 提交两条 → 改一条 → 提交一条冲突的。
// 每条都在临时目录里跑（submit 真的落盘，不 mock fs —— mock 出来的通过等于没验）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIndex } from '../src/index';
import { checkRepo, loadRepo, parseEvidenceAt, renderDoc, submit } from '../src/node/index';
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
    // 2026-10-23 大王判决：**库不存在 = 空库**。「读就出空、写就直接写」，没有"建库"这个动作
    // —— 原先这里抛 `facts/repo-missing`，逼得调用方各自抢在写之前把目录建出来
    // （`submit --dry-run` 因此会建库，把"库建没建"这个状态改掉）。
    it('目录不存在 = 空库（不抛、也不建目录）', () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'facts-'));
        tmp.push(root);
        const dir = path.join(root, 'knowledge');
        const repo = loadRepo(dir);
        expect(repo.facts).toEqual([]);
        expect(repo.files).toEqual([]);
        expect(repo.schemaIssues).toEqual([]);
        expect(existsSync(dir)).toBe(false);
    });

    // 「写就直接写」的另一半：空库 `submit` 不需要任何人先建目录（`atomic-write` 顺带 mkdir）。
    // 注意"不需要前置动作"指的是**环境**（目录/文件），不是**判据** —— 词表与证据照样要过，
    // 那是内容正确性，两件事别混。
    it('空库 + submit ⇒ 目录与文件自己出现', () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'facts-'));
        tmp.push(root);
        writeFileSync(path.join(root, 'README.md'), 'x\n');
        const dir = path.join(root, 'knowledge');
        const { report, problems } = submit(dir, {
            facts: [fact({ id: 'a', subject: 'app.port', aspect: 'default', value: '1' })],
            subjects: [{ key: 'app.port', description: '端口' }],
        });
        expect(problems).toEqual([]);
        expect(report.added).toEqual(['a']);
        expect(existsSync(path.join(dir, 'facts', 'app.yaml'))).toBe(true);
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
        // 头注由 note 生成；真源是 claim map：key 携带 subject/aspect，
        // 显式 id（≠ 派生值 `<subject>#<aspect>`）才写进条目
        expect(text.startsWith('# knowledge/facts/app.yaml')).toBe(true);
        expect(text).toContain('app.port#default:');
        expect(text).not.toContain('subject:');
    });

    it('显式 id 跨 claim 撞车：map key 唯一但 id 重复 → 仍由程序报 facts/id-duplicate', () => {
        // map 的 key 唯一只保证 claim 不重复；id 是**审计锚点**，跨 claim 撞车必须语义查重
        const dir = makeRepo({
            'app.yaml': [
                'domain: app',
                'facts:',
                '  app.a#x:',
                '    value: "1"',
                '    id: same-id',
                '    review: accepted',
                '    lifecycle: active',
                '    evidence: { source: code }',
                '  app.b#y:',
                '    value: "2"',
                '    id: same-id',
                '    review: accepted',
                '    lifecycle: active',
                '    evidence: { source: code }',
                '',
            ].join('\n'),
        });
        const idx = buildIndex(loadRepo(dir).facts);
        expect(idx.issues.map((i) => i.code)).toContain('facts/id-duplicate');
        expect(idx.issues.find((i) => i.code === 'facts/id-duplicate')?.detail).toContain('same-id');
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

describe('origin（每条事实的来源文件）', () => {
    // 回归：派生 id 带 scope 后缀（`app.port#default@env=production`），而读文件时能算出的
    // id 是 claim 形态 —— 只按 claim 记会让**每个变体都丢失来源**。症状不是报错，是静默：
    // `get` 的 file 变空串，且任何按 origin 分组的操作（整篇重排 / 迁移）会把整条 claim 丢掉
    // （实测丢过 `app.port#default` 的两个变体，连带 depends-on 指向它的事实变悬空）。
    it('带 scope 的变体（派生 id）也有来源文件', () => {
        const dir = makeRepo({
            'app.yaml': `domain: app
facts:
  app.port#default:
    - value: '0'
      scope: { env: [development, test] }
      review: accepted
      lifecycle: active
      evidence: { source: code, at: README.md:1 }
    - value: '18888'
      scope: { env: production }
      review: accepted
      lifecycle: active
      evidence: { source: code, at: README.md:1 }
`,
        });
        writeFileSync(path.join(dir, '..', 'README.md'), 'x\n');
        const repo = loadRepo(dir);
        expect(repo.facts).toHaveLength(2);
        for (const f of repo.facts) {
            expect(repo.origin.get(f.id)).toBe(path.join(dir, 'facts', 'app.yaml'));
        }
    });
});

describe('loadRepo extraDirs（设备级跨根只读）', () => {
    it('额外库的 claim 会并进来，主库已有的 claim 不覆盖', () => {
        const main = makeRepo();
        const extra = makeRepo();
        const mk = (id: string, subject: string, aspect: string, value: string): Fact =>
            fact({ id, subject, aspect, value, evidence: { source: 'code', at: 'K.ts:1', verifiedAt: '2026-10-21' } });
        writeFileSync(
            path.join(main, 'facts', 'a.yaml'),
            renderDoc({ domain: 'a', note: '', facts: [mk('x', 'app.port', 'default', '1000')] }),
        );
        writeFileSync(
            path.join(extra, 'facts', 'a.yaml'),
            renderDoc({
                domain: 'a',
                note: '',
                facts: [
                    // 同 claim：主库优先，extra 不覆盖
                    mk('x', 'app.port', 'default', '2000'),
                    // 主库没有：并进来
                    mk('y', 'app.port', 'resolution', '600'),
                ],
            }),
        );
        const repo = loadRepo(main, { extraDirs: [extra] });
        expect(repo.facts.map((f) => f.id).sort()).toEqual(['x', 'y']);
        expect(repo.facts.find((f) => f.id === 'x')!.value).toBe('1000');
    });

    it('主库同 claim 全被 superseded 时，额外库那份顶上（不是"知识消失"）', () => {
        const main = makeRepo();
        const extra = makeRepo();
        const mk = (id: string, value: string, lifecycle: 'active' | 'superseded'): Fact =>
            fact({
                id,
                subject: 'app.port',
                aspect: 'default',
                value,
                lifecycle,
                evidence: { source: 'code', at: 'K.ts:1', verifiedAt: '2026-10-21' },
            });
        writeFileSync(
            path.join(main, 'facts', 'a.yaml'),
            renderDoc({ domain: 'a', note: '', facts: [mk('x', '1000', 'superseded')] }),
        );
        writeFileSync(
            path.join(extra, 'facts', 'a.yaml'),
            renderDoc({ domain: 'a', note: '', facts: [mk('g', '2000', 'active')] }),
        );
        const repo = loadRepo(main, { extraDirs: [extra] });
        // claim 层面：主库那条"让位"，extra 那条并进来
        expect(repo.facts.map((f) => f.id).sort()).toEqual(['g', 'x']);
    });

    it('额外库坏了不影响主库（它是参考不是真源）', () => {
        const main = makeRepo();
        const extra = makeRepo();
        writeFileSync(path.join(extra, 'facts', 'bad.yaml'), 'facts: [unclosed\n');
        const repo = loadRepo(main, { extraDirs: [extra] });
        expect(repo.schemaIssues.filter((i) => i.level === 'error')).toHaveLength(0);
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

describe('evidence.at 钉版本（<rev>:<path>:<line>）', () => {
    // 场景来源：##5 第 9 轮实测 —— 源文件瘦身后行号必然越界，`at` 整批删 = 迁移类事实
    // 永久失去"它原来写在哪"。这里用真 git 仓（不是 mock）：`git show` 的判据必须真跑。
    function git(root: string, ...args: string[]): void {
        execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', root, ...args], { stdio: 'ignore' });
    }
    /** 建一个真仓：SRC.md 有 3 行，提交后瘦身成 1 行 —— rev 里的第 3 行仍然有效 */
    function makeGitRepo(evidenceAt: string): { dir: string; rev: string } {
        const root = mkdtempSync(path.join(os.tmpdir(), 'facts-git-'));
        tmp.push(root);
        git(root, 'init', '-q');
        writeFileSync(path.join(root, 'SRC.md'), 'l1\nl2\nl3\n');
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'full');
        const rev = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
        writeFileSync(path.join(root, 'SRC.md'), 'l1\n'); // 瘦身：当前工作树只剩 1 行
        const dir = path.join(root, 'knowledge');
        mkdirp(path.join(dir, 'facts'));
        writeFileSync(path.join(dir, 'subjects.yaml'), 'subjects:\n  app.port:\n    description: 端口\n');
        writeFileSync(
            path.join(dir, 'facts', 'app.yaml'),
            `domain: app\nfacts:\n  - id: a\n    subject: app.port\n    aspect: default\n    value: '1'\n    review: accepted\n    lifecycle: active\n    evidence: { source: code, at: '${evidenceAt}' }\n`,
        );
        return { dir, rev };
    }

    it('parseEvidenceAt：两段 = rev 形态，其余按路径', () => {
        expect(parseEvidenceAt('docs/a.md:12')).toEqual({ file: 'docs/a.md', line: 12 });
        expect(parseEvidenceAt('abc1234:docs/a.md:12')).toEqual({ rev: 'abc1234', file: 'docs/a.md', line: 12 });
        // 带 `/` 的段不当 rev（`origin/main` 这类分法会让普通路径被误判）
        expect(parseEvidenceAt('a/b:12')).toEqual({ file: 'a/b', line: 12 });
        expect(parseEvidenceAt('没有行号')).toBeNull();
    });

    it('钉住 rev 后，源文件瘦身不影响行号（裸路径形态则当场越界）', () => {
        const ok = makeGitRepo('__REV__:SRC.md:3');
        const text = readFileSync(path.join(ok.dir, 'facts', 'app.yaml'), 'utf8').replace('__REV__', ok.rev);
        writeFileSync(path.join(ok.dir, 'facts', 'app.yaml'), text);
        expect(checkRepo(ok.dir).problems.map((p) => p.code)).not.toContain('facts/evidence-line');

        const bare = makeGitRepo('SRC.md:3'); // 同一个事实，改成裸路径
        expect(checkRepo(bare.dir).problems.map((p) => p.code)).toContain('facts/evidence-line');
    });

    it('rev 不存在 / 该提交里没这个文件 → evidence-rev（不猜"大概指的是什么"）', () => {
        const { dir } = makeGitRepo('deadbeef:SRC.md:1');
        expect(checkRepo(dir).problems.map((p) => p.code)).toContain('facts/evidence-rev');
    });

    it('行号超出 rev 里的行数 → evidence-line（钉版本不等于免检）', () => {
        const { dir, rev } = makeGitRepo('__REV__:SRC.md:9');
        writeFileSync(path.join(dir, 'facts', 'app.yaml'), readFileSync(path.join(dir, 'facts', 'app.yaml'), 'utf8').replace('__REV__', rev));
        expect(checkRepo(dir).problems.map((p) => p.code)).toContain('facts/evidence-line');
    });
});

describe('submit · drop 把一篇文章删空 ⇒ 文件消失', () => {
    // 两代病史，同一处：
    //   ① 早期 `drop` 只从**存活集**建篇 → 一篇被删空后它不在存活集 ⇒ 不进写盘计划
    //      ⇒ 磁盘一个字不动，而 report 里 `dropped` 列了 id、`files` 为空（自相矛盾）
    //   ② 修①时选了"按空集重写、保留头注" —— 判据成立但结果错：空的 `facts: []` 壳
    //      不能 get、不占投影，只让 `knowledge/facts/` 堆"曾经有过"的空篇，
    //      而 `files: 218 B` 这种"变了其实什么都没了"的数字更误导。
    // 现在：删空 ⇒ 文件消失（语义与 `drop` 一致；历史由 git 留）。审计对象是事实不是文件。
    it('整篇删空后文件消失，status 不再报那几条', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\n');
        const ev = { source: 'code' as const, at: 'K.ts:1', verifiedAt: '2026-10-22' };
        submit(dir, {
            facts: [
                fact({ id: 'p1', subject: 'app.port', aspect: 'default', value: '18888', evidence: ev }),
                fact({ id: 'p2', subject: 'app.port', aspect: 'fallback', value: '18889', evidence: ev }),
            ],
        });
        expect(loadRepo(dir).facts).toHaveLength(2);

        const r = submit(dir, { facts: [], drop: ['p1', 'p2'] });
        expect(r.report.dropped).toEqual(['p1', 'p2']);
        // 关键不变量：dropped 有值 ⇒ files 必须非空（否则就是"report 说删了、磁盘没动"）
        expect(r.report.files.map((f) => path.basename(f.file))).toEqual(['app.yaml']);
        // `after === 0` ⇔ 本篇被删空、文件已消失（正常写盘恒有头注，不会 = 0）
        expect(r.report.files[0]?.after).toBe(0);

        expect(loadRepo(dir).facts).toHaveLength(0);
        expect(existsSync(path.join(dir, 'facts', 'app.yaml'))).toBe(false);
    });

    it('dry-run 不删文件（同一条路径，只差最后落盘）', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\n');
        const ev = { source: 'code' as const, at: 'K.ts:1', verifiedAt: '2026-10-22' };
        submit(dir, { facts: [fact({ id: 'p1', subject: 'app.port', aspect: 'default', value: '18888', evidence: ev })] });
        const r = submit(dir, { facts: [], drop: ['p1'], dryRun: true });
        expect(r.report.files[0]?.after).toBe(0);
        expect(existsSync(path.join(dir, 'facts', 'app.yaml'))).toBe(true);
    });

    it('删空一个主题 ⇒ 该库 expose.yaml 里那一行也摘掉（配置不许指向零事实的主题）', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\n');
        const ev = { source: 'code' as const, at: 'K.ts:1', verifiedAt: '2026-10-22' };
        writeFileSync(path.join(dir, 'expose.yaml'), 'expose:\n  app.port: full\n  dev.check: index\n');
        submit(dir, {
            facts: [
                fact({ id: 'p1', subject: 'app.port', aspect: 'default', value: '18888', evidence: ev }),
                fact({ id: 'd1', subject: 'dev.check', aspect: 'entry', value: './sha.sh check', evidence: ev }),
            ],
        });
        submit(dir, { facts: [], drop: ['p1'] });
        const text = readFileSync(path.join(dir, 'expose.yaml'), 'utf8');
        expect(text).not.toContain('app.port');
        // 还活着的主题不动
        expect(text).toContain('dev.check');
    });

    it('多篇里只删空其中一篇：另一篇照常不动', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\n');
        const ev = { source: 'code' as const, at: 'K.ts:1', verifiedAt: '2026-10-22' };
        submit(dir, {
            facts: [
                fact({ id: 'p1', subject: 'app.port', aspect: 'default', value: '18888', evidence: ev }),
                fact({ id: 'd1', subject: 'dev.check', aspect: 'entry', value: './sha.sh check', evidence: ev }),
            ],
        });
        const other = readFileSync(path.join(dir, 'facts', 'dev.yaml'), 'utf8');
        const r = submit(dir, { facts: [], drop: ['p1'] });
        // 存活篇照常重写（内容不变），被删空的那篇进 `files` 且 after = 0（= 文件已消失）
        expect(r.report.files.map((f) => path.basename(f.file)).sort()).toEqual(['app.yaml', 'dev.yaml']);
        expect(r.report.files.find((f) => f.file.endsWith('app.yaml'))?.after).toBe(0);
        expect(r.report.files.find((f) => f.file.endsWith('dev.yaml'))?.after).toBeGreaterThan(0);
        expect(readFileSync(path.join(dir, 'facts', 'dev.yaml'), 'utf8')).toBe(other);
    });
});

describe('submit · 词表删除（dropSubjects）', () => {
    // 起因（##5 实测）：`subjects` 原先只有增没有删 —— 写错一个 key 就永久占着词表，
    // 而 agent 不许手改 YAML，唯一出路是 `git checkout knowledge/subjects.yaml`。
    // 删入口必须与写入口同一条、同一事务。

    it('删掉无人使用的本地 subject：词表里消失，报告里列出', () => {
        const dir = makeRepo();
        const r = submit(dir, { facts: [], subjects: [{ key: 'app.tmp', description: '临时' }] });
        expect(r.problems.filter((p) => p.level === 'error')).toEqual([]);
        expect(loadRepo(dir).subjects.map((s) => s.key)).toContain('app.tmp');

        const del = submit(dir, { facts: [], dropSubjects: ['app.tmp'] });
        expect(del.report.droppedSubjects).toEqual(['app.tmp']);
        expect(loadRepo(dir).subjects.map((s) => s.key)).not.toContain('app.tmp');
        // 其余词表条目不受影响（删除不是"重写整份词表"）
        expect(loadRepo(dir).subjects.map((s) => s.key)).toContain('app.port');
    });

    it('仍被事实使用的 subject → subject-drop-in-use，且磁盘不动', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'K.ts'), 'a\nb\n');
        submit(dir, {
            facts: [fact({ id: 'p1', subject: 'app.port', aspect: 'default', value: '1', evidence: { source: 'code', at: 'K.ts:1' } })],
        });
        const before = readFileSync(path.join(dir, 'subjects.yaml'), 'utf8');
        const r = submit(dir, { facts: [], dropSubjects: ['app.port'] });
        expect(r.problems.map((p) => p.code)).toContain('facts/subject-drop-in-use');
        expect(readFileSync(path.join(dir, 'subjects.yaml'), 'utf8')).toBe(before);
    });

    it('继承来的 subject 删不掉（subject-drop-not-local）', () => {
        // 「继承」的准确语义（读 `readSubjects` 才发现）：**本地 `subjects.yaml` 不存在时才回落**
        // 到仓库那份；一旦本地文件存在（任务库首次写入就会建），继承当场断掉。所以要验
        // not-local，必须构造「本地没有词表文件」这一个窗口。
        const dir = makeRepo();
        const fallback = path.join(dir, '..', 'repo-subjects.yaml');
        writeFileSync(fallback, 'subjects:\n  app.port:\n    description: 应用监听端口\n');
        rmSync(path.join(dir, 'subjects.yaml'));
        const r = submit(dir, { facts: [], dropSubjects: ['app.port'] }, { subjectsFallback: fallback });
        expect(r.problems.map((p) => p.code)).toContain('facts/subject-drop-not-local');
        // 删失败 ⇒ 一个词表文件都不该被创建（"顺手把继承那份抄成快照"是最坏的副作用）
        expect(readdirSync(dir)).not.toContain('subjects.yaml');
    });

    it('同批既声明又删除 → subject-drop-declared（顺序不同结果不同 = 载荷写错）', () => {
        const dir = makeRepo();
        const r = submit(dir, { facts: [], subjects: [{ key: 'app.x', description: 'x' }], dropSubjects: ['app.x'] });
        expect(r.problems.map((p) => p.code)).toContain('facts/subject-drop-declared');
    });

    it('删不存在的 key 静默忽略（删不存在的东西不该算成功，也不该报错）', () => {
        const dir = makeRepo();
        const r = submit(dir, { facts: [], dropSubjects: ['app.nope'] });
        expect(r.problems.filter((p) => p.level === 'error')).toEqual([]);
        expect(r.report.droppedSubjects).toEqual([]);
    });
});

describe('W2 文件必须是内核渲染的结果（##9 review P1②：手改 / merge 坏序）', () => {
    it('submit 写出来的文件 ⇒ 不报 file-not-canonical', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'README.md'), 'x\n');
        submit(dir, {
            facts: [fact({ id: 'app.port.default', subject: 'app.port', aspect: 'default', value: '18888' })],
        });
        expect(checkRepo(dir).problems.map((p) => p.code)).not.toContain('facts/file-not-canonical');
    });

    it('手改（多一行空行）⇒ warning，且不阻断（内容仍能读）', () => {
        const dir = makeRepo();
        writeFileSync(path.join(dir, '..', 'README.md'), 'x\n');
        submit(dir, {
            facts: [fact({ id: 'app.port.default', subject: 'app.port', aspect: 'default', value: '18888' })],
        });
        const file = path.join(dir, 'facts', 'app.yaml');
        writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);
        const problems = checkRepo(dir).problems;
        const hit = problems.find((p) => p.code === 'facts/file-not-canonical');
        expect(hit?.level).toBe('warning');
        // 语义没坏：事实照读得到（序/空行不影响查询，所以只能是 warning）
        expect(loadRepo(dir).facts.map((f) => f.id)).toContain('app.port.default');
        // 修法在文案里（否则读日志的人只知道"红了"，不知道"重新生成就行"）
        expect(hit?.detail).toContain('diy facts submit');
    });
});
