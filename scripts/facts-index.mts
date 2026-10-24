#!/usr/bin/env node
// scripts/facts-index.mts — 事实库真源的机械护栏（##404）
//
// 为什么需要它：事实库真正的敌人不是「没有库」，是**腐坏** —— 同一 claim 两个值、证据指向
// 已被删的文件、subject 自由长出同义词、被替代的事实还标 active。这些都不用人肉 review，
// 程序全看得出来；人只负责「这话对不对」。故本脚本只管机械判据，不管语义。
//
//   G1 schema 合法    —— subject / aspect / value / evidence / scope 形状
//   G2 图结构完整      —— id 唯一 / claim 冲突 / 边悬空 / supersedes 成环
//   G3 subject 受控    —— fact.subject 必须在 knowledge/subjects.yaml 登记（新词先 review）
//   G4 证据可解析      —— evidence.at 的 `<路径>:<行>` 必须真存在（仓库相对 或 `~/` 开头）
//   G5 probe 档齐备    —— source=probe 必须有 evidence.probe（否则「验证过」是空话）
//   W1 证据陈旧        —— verifiedAt 超过 --max-age 天（缺省 180）= warning，不算失败
//   W2 文件非内核渲染   —— 手改 / merge 坏序（内容等价但字节不等）= warning，修法是 submit 重写
//
// **判据本身不在这里**：实现归 `@diy/facts/node`（`checkRepo`），因为同一套判据还有第二个
// 消费者 —— `diy facts submit` 落盘前要拿候选集跑一遍同样的检查（否则会出现「CLI 能写进去、
// CI 却红」的分叉）。本文件只负责：解析参数 / 打印 / 退出码 / 顺带生成 index.json。
//
// 用法：
//   npx tsx scripts/facts-index.mts                     校验（默认，供 ./sha.sh check 调用）
//   npx tsx scripts/facts-index.mts --write             顺带落 knowledge/index.json（工具读的缓存）
//   npx tsx scripts/facts-index.mts --json              打印索引（调试 / 工具消费）
//   npx tsx scripts/facts-index.mts --dir /tmp/kb       指向别处的真源（可测性 / 演练）
//   npx tsx scripts/facts-index.mts --as-of 2026-01-01 --max-age 90
//
// 退出码：0 = 通过（warning 不影响）· 1 = 有 error
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildIndex } from '@diy/facts';
import { checkRepo } from '@diy/facts/node';

const ROOT = path.resolve(import.meta.dirname, '..');

function main(argv: readonly string[]): number {
    const arg = (name: string): string | undefined => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const dir = path.resolve(arg('--dir') ?? path.join(ROOT, 'knowledge'));
    const asOfArg = arg('--as-of');
    const asOf = asOfArg !== undefined ? new Date(asOfArg) : new Date();
    const maxAgeDays = Number(arg('--max-age') ?? 180);
    if (Number.isNaN(asOf.getTime())) {
        console.error(`✗ --as-of 不是合法日期：${asOfArg}`);
        return 1;
    }

    let repo;
    let problems;
    try {
        ({ repo, problems } = checkRepo(dir, { asOf, maxAgeDays }));
    } catch (err) {
        console.error(`[facts] ✗ ${(err as Error).message}`);
        return 1;
    }

    const errors = problems.filter((p) => p.level === 'error');
    const warnings = problems.filter((p) => p.level === 'warning');
    for (const p of [...errors, ...warnings]) {
        console.log(`  ${p.level === 'error' ? '✗' : '⚠'} [${p.code}] ${p.detail}`);
    }
    if (errors.length > 0) {
        const codes = [...new Set(errors.map((e) => e.code))].join(', ');
        console.error(`[facts] ✗ ${errors.length} error / ${warnings.length} warning（${codes}）`);
        return 1;
    }

    if (argv.includes('--json') || argv.includes('--write')) {
        const index = buildIndex(repo.facts);
        const claims: Record<string, string[]> = {};
        for (const [k, v] of [...index.claims].sort(([a], [b]) => a.localeCompare(b))) claims[k] = [...v];
        const backlinks: Record<string, string[]> = {};
        for (const [k, v] of index.backlinks) backlinks[k] = [...v];
        const text = `${JSON.stringify(
            {
                _note: '生成物，勿手改（npx tsx scripts/facts-index.mts --write）。真源 = knowledge/facts/*.yaml',
                sources: repo.files.map((f) => path.relative(ROOT, f)),
                counts: { facts: repo.facts.length, claims: index.claims.size },
                claims,
                backlinks,
            },
            null,
            2,
        )}\n`;
        if (argv.includes('--json')) process.stdout.write(text);
        if (argv.includes('--write')) {
            const out = path.join(dir, 'index.json');
            mkdirSync(path.dirname(out), { recursive: true });
            writeFileSync(out, text);
        }
    }

    const subjects = new Set(repo.facts.map((f) => f.subject)).size;
    const claims = new Set(repo.facts.map((f) => `${f.subject}#${f.aspect}`)).size;
    console.log(`[facts] ✅ 通过（${repo.facts.length} facts / ${subjects} subject / ${claims} claim，${repo.files.length} 文件 · ${warnings.length} warning）`);
    return 0;
}

process.exit(main(process.argv.slice(2)));
