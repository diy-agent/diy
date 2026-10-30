#!/usr/bin/env node
// scripts/facts-project.mts — 事实库的**投影预览 / A/B 对比**（##404）
//
// 投影 = 真源面向读取侧的视图（`@diy-agent/facts/node` 的 `project`）。同真源可换算法，
// 本脚本就是用来**实测哪种更省 token / 更好用的**（不靠推演）：
//
//   npx tsx scripts/facts-project.mts                          # 三种算法字节对比 + 问题清单
//   npx tsx scripts/facts-project.mts --algo yaml-nested        # 打印某一种全文
//   npx tsx scripts/facts-project.mts --algo md-list --env test
//   npx tsx scripts/facts-project.mts --max-bytes 2048          # 按预算裁（看裁掉哪些）
//
// 参数：`--env production|development|test`（变体解析依据，缺省 production）
//       `--paths a,b`（路径型事实召回）· `--task projects/4/tasks/404` · `--ns` 前缀（缺省 project）
//
// 退出码：0 = 正常（有投影冲突就是 1 —— 冲突不是"没事"，是库坏了）
import path from 'node:path';
import process from 'node:process';
import { loadRepo, PROJECTION_ALGORITHMS, project, type ProjectionAlgorithm } from '@diy-agent/facts/node';
import { formatNs, parseNs, type Env } from '@diy-agent/facts';

const ROOT = path.resolve(import.meta.dirname, '..');

function main(argv: readonly string[]): number {
    const arg = (name: string): string | undefined => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };

    const nsText = arg('--ns') ?? 'project';
    const ns = parseNs(nsText);
    if (!ns.ok) {
        console.error(`✗ 命名空间非法：${ns.detail ?? ns.code}`);
        return 1;
    }

    const envText = arg('--env') ?? 'production';
    const envs = ['production', 'development', 'test'];
    if (!envs.includes(envText)) {
        console.error(`✗ --env 必须是 ${envs.join(' | ')}`);
        return 1;
    }
    const paths = (arg('--paths') ?? '').split(',').filter((s) => s !== '');
    const task = arg('--task');
    const ctx = {
        env: envText as Env,
        ...(paths.length > 0 ? { paths } : {}),
        ...(task === undefined ? {} : { task }),
    };

    const repo = loadRepo(path.join(ROOT, 'knowledge'));
    const entries = repo.facts.map((fact) => ({ ns: ns.value, fact }));
    const algo = arg('--algo');
    const maxBytes = arg('--max-bytes');

    const one = (algorithm: ProjectionAlgorithm) =>
        project({
            entries,
            ctx,
            algorithm,
            ...(maxBytes === undefined ? {} : { maxBytes: Number(maxBytes) }),
        });

    console.log(`ns=${formatNs(ns.value)}  ctx=${JSON.stringify(ctx)}  facts=${repo.facts.length}\n`);

    if (algo !== undefined) {
        const out = one(algo as ProjectionAlgorithm);
        console.log(out.text);
        console.log(
            `\n— ${out.algorithm}: ${out.bytes} B / ${out.shown.length} 条` +
                (out.omitted.length > 0 ? `，裁掉 ${out.omitted.length} 条` : '') +
                (out.skipped.length > 0 ? `，不适用 ${out.skipped.length} 条` : ''),
        );
        for (const p of out.problems) console.error(`✗ [${p.code}] ${p.gid}${p.detail === undefined ? '' : ` — ${p.detail}`}`);
        return out.problems.length === 0 ? 0 : 1;
    }

    let bad = 0;
    console.log('算法            字节    条数  说明');
    for (const algorithm of PROJECTION_ALGORITHMS) {
        const out = one(algorithm);
        bad += out.problems.length;
        const note =
            algorithm === 'yaml-nested'
                ? '父节点=ns，子键=claim（结构化，省前缀）'
                : algorithm === 'flat-gid'
                  ? '每条全 gid（可 grep，跨库引用友好）'
                  : '一行一条 markdown（最省格式符）';
        console.log(`${algorithm.padEnd(14)}${String(out.bytes).padStart(6)}  ${String(out.shown.length).padStart(5)}  ${note}`);
        if (out.skipped.length > 0) console.log(`  · 不适用（当前 ctx 下跳过）：${out.skipped.join(', ')}`);
        for (const p of out.problems) console.error(`  ✗ [${p.code}] ${p.gid}${p.detail === undefined ? '' : ` — ${p.detail}`}`);
    }
    return bad === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
