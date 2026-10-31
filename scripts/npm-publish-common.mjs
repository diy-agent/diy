#!/usr/bin/env node
// scripts/npm-publish-common.mjs — npm 发布的两份脚本（能力包 / app）共用的那一段。
//
// 为什么单拆：`npm-publish.mjs`（能力包，lib/ 产物）与 `npm-publish-app.mjs`（app，build/ 产物）
// 的**产物形态不同**，但「认证 / registry / 临时 userconfig / 内部依赖版本」完全一样：
// 抄两份必然漂移（##478 的教训：发布脚本不在库里，发出去的包就只能靠人记得改）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 发布目标：官方 registry（本机 ~/.npmrc 常指淘宝镜像，必须显式覆盖） */
export const REGISTRY = 'https://registry.npmjs.org/';

/**
 * 取发布 token：优先环境变量；非交互 shell 不读 ~/.bashrc，故回落到那里
 * （本机约定 token 存 `~/.bashrc` 的 `export NPM_PUBLISH_TOKEN="npm_…"`）。
 */
export function resolveToken() {
    if (process.env.NPM_PUBLISH_TOKEN) return process.env.NPM_PUBLISH_TOKEN;
    const rc = path.join(os.homedir(), '.bashrc');
    if (!existsSync(rc)) return undefined;
    const m = readFileSync(rc, 'utf8').match(/^\s*export\s+NPM_PUBLISH_TOKEN=["']?([^"'\s]+)["']?\s*$/m);
    return m?.[1];
}

/** 发布某个目录（该目录里必须是**发行形态**的 package.json） */
export function publishDir(dir, { dryRun = false } = {}) {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (alreadyPublished(manifest.name, manifest.version)) {
        console.log(`= ${manifest.name}@${manifest.version} 已在 registry 上，跳过（npm 不允许重发同版本）`);
        return false;
    }
    const token = resolveToken();
    if (!token) {
        throw new Error('未找到 NPM_PUBLISH_TOKEN（环境变量或 ~/.bashrc 的 export NPM_PUBLISH_TOKEN="npm_…"）');
    }
    // 临时 userconfig：① 绕开 ~/.npmrc 里的淘宝镜像 ② token 用 ${VAR} 引用，**不落明文**
    const cfgDir = mkdtempSync(path.join(os.tmpdir(), 'diy-npm-publish-'));
    const userconfig = path.join(cfgDir, '.npmrc');
    writeFileSync(userconfig, `registry=${REGISTRY}\n//registry.npmjs.org/:_authToken=\${NPM_PUBLISH_TOKEN}\n`);
    try {
        const args = ['publish', '--userconfig', userconfig, '--workspaces=false', '--access', 'public'];
        if (dryRun) args.push('--dry-run');
        console.log(`▶ npm publish（cwd=${path.relative(process.cwd(), dir) || '.'}，registry=${REGISTRY}）`);
        execFileSync('npm', args, { cwd: dir, stdio: 'inherit', env: { ...process.env, NPM_PUBLISH_TOKEN: token } });
        console.log(`✓ 发布完成：${manifest.name}@${manifest.version}`);
        return true;
    } finally {
        rmSync(cfgDir, { recursive: true, force: true });
    }
}

/** registry 上已有这个版本？（发布要可重复跑：部分失败后重跑不该被「版本已存在」卡住） */
function alreadyPublished(name, version) {
    try {
        const out = execFileSync('npm', ['view', `${name}@${version}`, 'version', '--registry', REGISTRY], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim() === version;
    } catch {
        return false;
    }
}

/** 仓内所有 workspace 包：包名 → { version, dir }（pkgs.ts/* 与 apps/*） */
export function workspacePackages(root) {
    const out = new Map();
    for (const parent of ['pkgs.ts', 'apps']) {
        const base = path.join(root, parent);
        if (!existsSync(base)) continue;
        for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const file = path.join(base, entry.name, 'package.json');
            if (!existsSync(file)) continue;
            try {
                const pkg = JSON.parse(readFileSync(file, 'utf8'));
                if (pkg.name) out.set(pkg.name, { version: pkg.version, dir: path.join(base, entry.name) });
            } catch {
                // 坏 package.json 不归本脚本管（check 会红）
            }
        }
    }
    return out;
}

/**
 * 仓内依赖写的是 `*` / `workspace:*`（npm workspaces 约定），**发行物不能这么写**：
 * 用户装到的是 registry 里的真版本，`*` 等于「随便哪个版本」，2026-10-30 就撞过这个坑
 * （chat-page@0.1.0 依赖 `@diy-agent/ui: ^0.1.0`，而 ui 早就是 0.2.0 ⇒ 装回旧版）。
 * 这里统一改写成 `^<仓内版本>`。
 */
export function resolveInternalDeps(deps, versions) {
    if (!deps) return deps;
    const out = {};
    for (const [name, range] of Object.entries(deps)) {
        if (!name.startsWith('@diy-agent/')) {
            out[name] = range;
            continue;
        }
        const local = versions.get(name);
        if (!local) {
            throw new Error(`依赖 ${name} 在仓内找不到对应 workspace 包 —— 发行物会装到不存在的版本`);
        }
        const wildcard = range === '*' || range === 'workspace:*' || range === 'latest';
        if (!wildcard && range !== `^${local.version}` && range !== local.version) {
            console.log(`  · ${name}: 仓内写的是 ${range}，按仓内版本改成 ^${local.version}`);
        }
        out[name] = `^${local.version}`;
    }
    return out;
}

/** 发行版 package.json 的公共字段（按需覆盖 main / exports / files / bin） */
export const PASSTHROUGH = [
    'name',
    'version',
    'description',
    'keywords',
    'license',
    'repository',
    'homepage',
    'bugs',
    'author',
    'type',
    'engines',
    'sideEffects',
];

/** 生成发行版 package.json 对象（调用方再补 main / exports / files / bin） */
export function releaseManifest(pkg, versions) {
    const out = {};
    for (const key of PASSTHROUGH) {
        if (pkg[key] !== undefined) out[key] = pkg[key];
    }
    out.type = pkg.type ?? 'module';
    if (pkg.private === true) console.log('  · 仓内 private:true 已剥离（发行物必须可发布）');
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        if (pkg[field]) out[field] = resolveInternalDeps(pkg[field], versions);
    }
    out.publishConfig = { registry: REGISTRY, access: 'public' };
    return out;
}
