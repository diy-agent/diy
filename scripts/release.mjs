#!/usr/bin/env node
// scripts/release.mjs — 发版工具：bump 版本 + 同步仓内引用 + 看谁还没发（##522）
//
// 为什么需要（用户 2026-11-10：「能否有个发布流程的工具，现在要手工改 version」）：
// npm 不允许重发同版本 ⇒ 每次发布前必须先改 version。而 version 不在一处：
//   ① 包自己的 package.json；
//   ② 指向它的**内部依赖范围**（`^x.y.z` / `x.y.z`）—— npm-publish-common 的
//      resolveInternalDeps 会在发布时按仓内版本改写，但仓内写着旧范围会让「读代码的人以为
//      装的就是那个版本」，且范围的校验/告警本身也是噪音；
//   ③ package-lock.json 里该 workspace 目录的 `version`（不改则 `npm ci` 与 package.json 失配）。
// 手工改三处，漏一处就在 publish / npm ci 上炸；本脚本把「一处决定、三处同步」固化下来。
//
// 用法（仓根跑；`./sha.sh release ...` 是同一件事的入口）：
//   node scripts/release.mjs status                      本地版本 vs registry（谁还没发）
//   node scripts/release.mjs bump patch|minor|major      全量 bump（缺省）
//       [--only a,b]       只 bump 这几个（仓相对目录或包名）
//       [--set 包=版本]    指定成品版本（不跑 bump 算法），可与 --only 混用
//       [--dry-run]        只打印将改什么，不落盘
//   node scripts/release.mjs self-test                   纯逻辑自检
//
// 边界：**只改文件、不提交、不打 tag、不发包**。理由：版本号是人对外的承诺，交给 git
// review 一眼看得见；发布仍走 ./sha.sh publish（它自己会 build + 比对 registry 跳过同版本）。
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { REGISTRY } from './npm-publish-common.mjs';
import { PUBLISH_TARGETS } from './publish-targets.mjs';
import { REPO_ROOT, workspaceDirs } from './workspace-dirs.mjs';

const execFileP = promisify(execFile);

// ── 纯逻辑（self-test 覆盖；改这里请同步加用例） ──────────────────────────────

/** `0.1.0` + patch → `0.1.1`；预发布后缀（`0.1.0-beta.1`）按「只动核心三段」处理 */
export function bumpVersion(version, kind) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!m) throw new Error(`版本号解析不了：${version}`);
    let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (kind === 'major') [major, minor, patch] = [major + 1, 0, 0];
    else if (kind === 'minor') [minor, patch] = [minor + 1, 0];
    else if (kind === 'patch') patch += 1;
    else throw new Error(`bump 只认 patch / minor / major，收到：${kind}`);
    return `${major}.${minor}.${patch}`;
}

/**
 * 依赖范围跟着仓内版本走。
 * @returns 新范围；不是「指这个精确版本」的写法（`*` / `workspace:*` / `file:` / 自己写的区间）→ null（不动）
 */
export function followRange(range, oldVersion, newVersion) {
    const prefix = range.startsWith('^') ? '^' : range.startsWith('~') ? '~' : '';
    const bare = prefix ? range.slice(1) : range;
    if (bare !== oldVersion) return null; // `*` / `file:…` / 区间（`>=1 <2`）都不归 bump 管
    return `${prefix}${newVersion}`;
}

/** 在 lock 文本里把某 workspace 目录条目的 version 改掉（该锁文件是按 2 空格序列化的，可解析后写回） */
export function bumpLock(lock, dirs, bumps) {
    for (const dir of dirs) {
        const entry = lock.packages?.[dir];
        if (!entry) continue; // 该目录不在 lock 里（新包还没 install 过）：留给 npm 自己补
        const next = bumps.get(dir);
        if (next) entry.version = next;
    }
    return lock;
}

// ── 读写 ─────────────────────────────────────────────────────────────────────

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * 写回时**保留原文件的缩进与行尾**：仓里 package.json 有 2 空格也有 4 空格的，
 * 统一成 2 空格会把整个文件重排（bump 一个版本号产生几百行 diff，review 就废了）。
 */
const writeJson = (p, o) => {
    const text = readFileSync(p, 'utf8');
    const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let out = JSON.stringify(o, null, indent);
    if (eol !== '\n') out = out.replace(/\n/g, eol);
    writeFileSync(p, text.endsWith('\n') ? `${out}${eol}` : out);
};
const rel = (p) => path.relative(REPO_ROOT, p);

/** 仓内所有 workspace 包（含 apps/*）：dir → package.json 路径 */
function workspaceManifests() {
    return workspaceDirs(REPO_ROOT).map((dir) => ({ dir, file: path.join(REPO_ROOT, dir, 'package.json') }));
}

// ── status ──────────────────────────────────────────────────────────────────

async function latestPublished(name) {
    try {
        const { stdout } = await execFileP('npm', ['view', name, 'version', '--registry', REGISTRY], {
            encoding: 'utf8',
        });
        return stdout.trim() || null;
    } catch {
        return null; // 没发过 / 网络不通 —— 两者都记「-」
    }
}

async function status() {
    const rows = await Promise.all(
        PUBLISH_TARGETS.map(async (dir) => {
            const pkg = readJson(path.join(REPO_ROOT, dir, 'package.json'));
            return { dir, name: pkg.name, local: pkg.version, remote: await latestPublished(pkg.name) };
        }),
    );
    const w = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
    console.log(`${w('目录', 30)} ${w('包名', 30)} ${w('本地', 10)} ${w('registry', 10)} 状态`);
    let pending = 0;
    for (const r of rows) {
        const state = r.remote === null ? '未发布' : r.remote === r.local ? '已发' : `待发（registry=${r.remote}）`;
        if (r.remote !== r.local) pending += 1;
        console.log(`${w(r.dir, 30)} ${w(r.name, 30)} ${w(r.local, 10)} ${w(r.remote ?? '-', 10)} ${state}`);
    }
    console.log(`\n${rows.length} 个可发布目标，其中 ${pending} 个本地版本与 registry 不同（= 该发或该 bump）`);
}

// ── bump ────────────────────────────────────────────────────────────────────

function bump(kind, { only, sets, dryRun }) {
    const manifests = workspaceManifests();
    const targets = new Map(); // dir → pkg
    for (const dir of PUBLISH_TARGETS) {
        const file = path.join(REPO_ROOT, dir, 'package.json');
        targets.set(dir, { dir, file, pkg: readJson(file) });
    }
    const byName = new Map([...targets.values()].map((t) => [t.pkg.name, t]));
    const dirToTarget = new Map([...targets.values()].map((t) => [t.dir, t]));

    // 选哪些：--only 给了就只动它们；--set 里点名的也算
    const picked = new Set();
    for (const raw of only) {
        const t = dirToTarget.get(raw) ?? byName.get(raw);
        if (!t) throw new Error(`--only 里找不到：${raw}（写仓相对目录或包名）`);
        picked.add(t);
    }
    for (const [key] of sets) {
        const t = dirToTarget.get(key) ?? byName.get(key);
        if (!t) throw new Error(`--set 里找不到：${key}`);
        picked.add(t);
    }
    const chosen = picked.size > 0 ? [...picked] : [...targets.values()];

    const bumps = new Map(); // dir → { name, from, to }
    for (const t of chosen) {
        const from = t.pkg.version;
        const explicit = sets.get(t.dir) ?? sets.get(t.pkg.name);
        const to = explicit ?? bumpVersion(from, kind);
        if (to === from) throw new Error(`${t.pkg.name} 的新版本与旧版本相同（${from}）`);
        bumps.set(t.dir, { name: t.pkg.name, from, to });
    }
    // 新版本 → 旧版本（改引用时按旧值匹配，避免误伤写死成别的版本的少数依赖）
    const byPackage = new Map([...bumps.values()].map((b) => [b.name, b]));

    console.log(`bump（${kind}）${bumps.size} 个目标${dryRun ? '（dry-run，不落盘）' : ''}：`);
    for (const b of bumps.values()) console.log(`  ${b.name}  ${b.from} → ${b.to}`);

    // ① 包自身的 package.json
    for (const [dir, b] of bumps) {
        const t = targets.get(dir);
        t.pkg.version = b.to;
        if (!dryRun) writeJson(t.file, t.pkg);
    }

    // ② 仓内引用它的依赖范围（含 devDependencies 等；范围写法见 followRange）
    let rangeEdits = 0;
    for (const { dir, file } of manifests) {
        const pkg = readJson(file);
        let touched = false;
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
            const deps = pkg[field];
            if (!deps) continue;
            for (const [name, range] of Object.entries(deps)) {
                const b = byPackage.get(name);
                if (!b) continue;
                const next = followRange(range, b.from, b.to);
                if (!next) continue;
                if (!dryRun) deps[name] = next;
                touched = true;
                rangeEdits += 1;
                console.log(`  · ${dir}: ${name} ${range} → ${next}`);
            }
        }
        if (touched && !dryRun) writeJson(file, pkg);
    }

    // ③ package-lock.json 的 workspace 条目（npm ci 按它对版本）
    const lockPath = path.join(REPO_ROOT, 'package-lock.json');
    const lock = readJson(lockPath);
    const before = JSON.stringify(lock);
    bumpLock(
        lock,
        [...bumps.keys()],
        new Map([...bumps].map(([dir, b]) => [dir, b.to])),
    );
    const lockChanged = JSON.stringify(lock) !== before;
    if (lockChanged && !dryRun) writeJson(lockPath, lock);

    console.log(
        `\n合计：${bumps.size} 个版本、${rangeEdits} 处依赖范围${
            lockChanged ? (dryRun ? '、package-lock.json 会同步' : '、package-lock.json 已同步') : ''
        }`,
    );
    if (dryRun) return;
    // ④ 重写 sync 印记：它的 hash 覆盖 package-lock.json + 各包 package.json 全文，
    //    只改版本号时 node_modules 的**链接关系**并没有变，重写才算诚实 —— 否则下一次
    //    ./sha.sh check 会判「node_modules 落后」并触发一次全量 npm i（几分钟）。
    try {
        execFileSync('node', [path.join(REPO_ROOT, 'scripts/check-sync.mjs'), '--write-stamp'], {
            cwd: REPO_ROOT,
            stdio: 'inherit',
        });
    } catch {
        console.log('（跳过 sync 印记重写：本 worktree 还没有 node_modules，跑过 ./sha.sh sync 后再来）');
    }
    console.log('下一步：./sha.sh build && ./sha.sh publish --dry-run（先演练一遍）→ ./sha.sh publish → git commit');
}

// ── 自检 ────────────────────────────────────────────────────────────────────

function selfTest() {
    const eq = (a, b, msg) => {
        const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
        if (x !== y) throw new Error(`${msg}：期望 ${y}，实际 ${x}`);
    };
    eq(bumpVersion('0.1.0', 'patch'), '0.1.1', 'patch');
    eq(bumpVersion('0.1.9', 'minor'), '0.2.0', 'minor 进位');
    eq(bumpVersion('0.9.9', 'major'), '1.0.0', 'major 进位');
    eq(bumpVersion('0.1.0-beta.2', 'patch'), '0.1.1', '预发布后缀只动核心三段');
    eq(followRange('^0.1.0', '0.1.0', '0.1.1'), '^0.1.1', '插入符跟随');
    eq(followRange('0.1.0', '0.1.0', '0.1.1'), '0.1.1', '精确版本跟随');
    eq(followRange('~0.1.0', '0.1.0', '0.1.1'), '~0.1.1', '波浪号跟随');
    eq(followRange('*', '0.1.0', '0.1.1'), null, '通配不动');
    eq(followRange('file:../../x', '0.1.0', '0.1.1'), null, 'file: 不动');
    eq(followRange('>=0.1.0 <0.2.0', '0.1.0', '0.1.1'), null, '区间不动');
    eq(followRange('^0.2.0', '0.1.0', '0.1.1'), null, '写死别的版本的引用不动');
    const lock = { packages: { 'pkgs.ts/a': { version: '0.1.0' }, 'x/y': { version: '1.0.0' } } };
    bumpLock(lock, ['pkgs.ts/a', 'nope/z'], new Map([['pkgs.ts/a', '0.1.1'], ['nope/z', '9.9.9']]));
    eq(lock.packages['pkgs.ts/a'].version, '0.1.1', 'lock 条目跟随');
    eq(lock.packages['nope/z'], undefined, 'lock 里没有的目录不凭空造');
    console.log('✓ release.mjs 自检通过（13 例）');
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd = argv[0];
/** 取 `--x v` 与 `--x=v` 两种写法的值（只认一种的话，另一种会静默丢失 —— ##522 的教训） */
const valuesOf = (name) =>
    argv
        .flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : a.startsWith(`--${name}=`) ? [a.slice(name.length + 3)] : []))
        .filter((v) => v !== undefined);
const dryRun = argv.includes('--dry-run');
const only = valuesOf('only').flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
const sets = new Map(
    valuesOf('set').map((kv) => {
        const [k, v] = kv.split('=');
        if (!k || !v) throw new Error(`--set 要写成 包=版本，收到：${kv}`);
        return [k, v];
    }),
);

try {
    if (cmd === 'status') await status();
    else if (cmd === 'self-test') selfTest();
    else if (cmd === 'bump') {
        const kind = argv[1];
        if (!['patch', 'minor', 'major'].includes(kind)) throw new Error('用法：release bump patch|minor|major');
        bump(kind, { only, sets, dryRun });
    } else {
        console.error('用法：node scripts/release.mjs status | bump patch|minor|major [--only a,b] [--set 包=版本] [--dry-run] | self-test');
        process.exit(2);
    }
} catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}
