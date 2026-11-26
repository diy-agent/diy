// scripts/check-dist-fresh.mjs —— 「运行时读 dist 的包，dist 是不是跟不上源码」
//
// ── 为什么需要它（2026-11-26 实测事故）──
// 30+ 个包的 package.json 里 `main` / `exports["."].default` 指向 `dist/*.js` —— **运行时读的是
// dist，不是 src**；而 `./sha.sh check` 是 `tsc -b --noEmit`（只类型检查，不重建），
// `./sha.sh dev` 也不重建。于是「合了别人的改动但没 build」在开发时**完全不可见**：
// 本地跑的是几周前的产物。这次的具体形态是 `@diy-agent/tools` 的 dist 停在 11-24，
// 少了 `await host.toModelOutput(...)` ⇒ 每轮第二次工具调用必被网关 400 打回，
// 模型永远走不到「规划 / 建账本」那一步，查了大半天才发现是产物陈旧。
//
// ── 判据：问 tsc 自己（`tsc -b <build-all> --dry`），不比 mtime ──
// 一开始写的是「src 最新 mtime vs dist 最新 mtime」，实测**假红**：`git stash pop` / `checkout`
// 会把 src 的 mtime 刷新，而 tsc 增量按内容判定「不必重编」，于是 dist 永远显得旧。
// `tsc -b --dry` 才是权威：它自己知道哪个 project 的产物落后（"Project ... is out of date"）。
// 代价 ~1.5s（读一遍 project 图），而漏判的代价是「拿旧产物调一天」。
//
// ── 用法 ──
//   node scripts/check-dist-fresh.mjs     # 有问题退出码 1（check 用它只拦不修）
// 重建交给调用方：`./sha.sh build-pkgs`（增量；dev 启动时自动跑，见 sha.sh 的 dist-fresh --build）
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const plan = path.join(root, 'build/tsconfig.build-all.json');

if (!existsSync(plan)) {
    // 生成物不在（clean 过 / 新 worktree）：不当失败 —— `./sha.sh build-pkgs` 会先生成它
    console.log('[dist] 跳过：build/tsconfig.build-all.json 不存在（先跑 ./sha.sh build-pkgs）');
    process.exit(0);
}

const tsc = path.join(root, 'node_modules/.bin/tsc');
const run = spawnSync(existsSync(tsc) ? tsc : 'npx', [...(existsSync(tsc) ? [] : ['tsc']), '-b', plan, '--dry'], {
    cwd: root,
    encoding: 'utf8',
});

if (run.status !== 0) {
    console.error('[dist] tsc -b --dry 失败，无法判定产物新旧：');
    console.error((run.stdout ?? '') + (run.stderr ?? ''));
    process.exit(1);
}

// 输出两种句式（都见过，别只认一种）：
//   11:40:09 AM - Project '/…/pkgs.ts/agent/rpc/tsconfig.build.json' is up to date
//   11:41:02 AM - A non-dry build would build project '/…/pkgs.ts/agent/tools/tsconfig.build.json'
const stale = [];
for (const line of (run.stdout ?? '').split('\n')) {
    const m = /(?:A non-dry build would build project|Project) '(.+?)'(?: is out of date|\s*$)/.exec(line.trim());
    if (m === null) continue;
    if (/is up to date/.test(line)) continue;
    stale.push(path.relative(root, path.dirname(m[1])));
}

if (stale.length === 0) {
    console.log('[dist] ✅ 运行时读 dist 的包，产物都跟得上源码');
    process.exit(0);
}

console.error(`[dist] ❌ ${stale.length} 个包的 dist 落后于源码（运行时读的是 dist，本地会跑旧代码）：`);
for (const dir of stale) console.error(`  · ${dir}`);
console.error('  重建：./sha.sh build-pkgs（增量，热 ~0.4s）');
process.exit(1);
