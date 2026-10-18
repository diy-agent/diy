#!/usr/bin/env node
// scripts/ensure-electron.mjs — electron 二进制「全机一份 store + 每个 worktree 一根软链」。
//
// 为什么需要它（2026-10 实测，见 AGENTS.md `tool.electron`）：
//   ① electron 43 的 package.json **没有 postinstall**（`scripts` 省略）：二进制由
//      `node_modules/electron/index.js` 在 `require('electron')` 时**惰性下载、且无超时**
//      ⇒ 缺 dist / path.txt 时，vitest / preview 起 Electron 会**静默卡死**（实测 3m40s、CPU 0%，
//      日志看着像"在跑"）。`path.txt` 只在首次安装时写，光链 dist 不写它照样落进下载。
//   ② `@electron/get` 的缓存键 = **下载 URL 目录**的 sha256（`Cache.js::getCacheDirectory`）：
//      npm 安装时带 `npm_config_electron_mirror`（本机 `~/.npmrc` → npmmirror），而运行时直接
//      node 拿不到它 ⇒ 走 GitHub URL ⇒ 另一个键 ⇒ **缓存里明明有 zip 还是重下**。
//   本脚本自己收口：store 按 `v<version>-<platform>-<arch>` 分目录（与镜像 URL 无关、跨 worktree
//   复用），worktree 里 `node_modules/electron/dist` 只留软链（304MB/份 → 全机一份）。
//
// 布局：
//   <store>/v43.1.1-darwin-x64/            解压后的 dist 内容（Electron.app / version / LICENSE…）
//   <store>/v43.1.1-darwin-x64.tmp-<pid>/  解压中转（成功后 rename，避免半截 store）
//   <repo>/node_modules/electron/dist → 上述目录
//
// 用法：
//   node scripts/ensure-electron.mjs                # 缺则补（允许下载，带超时）；已就绪则什么都不做
//   node scripts/ensure-electron.mjs --no-download   # 只用本地（store / 本地 zip / 本地实目录），不联网
//   node scripts/ensure-electron.mjs --soft          # 失败不阻断（退出码仍 0，只告警）—— 给 sync-deps 用
//   node scripts/ensure-electron.mjs --keep-local    # 不动已有的实目录 dist（只补 path.txt）
//   node scripts/ensure-electron.mjs --force         # 忽略 store 校验，重解压
//   node scripts/ensure-electron.mjs --quiet         # 成功时不打印（告警/错误照印）
//
// 环境变量：
//   DIY_ELECTRON_STORE=<dir>        store 根（缺省 <cache>/diy/electron）
//   DIY_ELECTRON_SHARED=0           不共享：各 worktree 自己的实目录 dist（本脚本只负责补一次并写 path.txt）
//   DIY_ELECTRON_KEEP_LOCAL_DIST=1  同 --keep-local
//   DIY_ELECTRON_TIMEOUT_MS=<ms>    下载超时（缺省 300000 = 5 分钟）
//   DIY_ELECTRON_ZIP=<zip>          指定本地 zip（离线 / 内网分发）
//   ELECTRON_MIRROR / DIY_ELECTRON_MIRROR / npmrc 的 electron_mirror → 下载镜像
//
// 退出码：0 已就绪 / 1 没就绪且修不了（--soft 下恒 0）
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 仓根（`scripts/` 的上一级）；`DIY_ENSURE_ELECTRON_ROOT` 只为可测性留的口子（沙箱树里验行为）
const REPO_ROOT = path.resolve(process.env.DIY_ENSURE_ELECTRON_ROOT ?? path.join(HERE, '..'));

// 平台 → dist 内的可执行文件相对路径（与 electron/install.js 的 getPlatformPath 同口径）
const EXE_REL = {
  darwin: 'Electron.app/Contents/MacOS/Electron',
  mas: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
  freebsd: 'electron',
  openbsd: 'electron',
  win32: 'electron.exe',
};

export function platformExe(platform = process.platform) {
  const exe = EXE_REL[platform];
  if (!exe) throw new Error(`electron 不支持平台 ${platform}`);
  return exe;
}

/** 各平台的用户缓存根（macOS 是 ~/Library/Caches，其余 XDG） */
export function cacheHome() {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches')
    : path.join(os.homedir(), '.cache');
}

export function storeRoot() {
  return process.env.DIY_ELECTRON_STORE || path.join(cacheHome(), 'diy', 'electron');
}

/** electron 自带下载缓存的根（`@electron/get` 缺省 = env-paths('electron').cache）；只用来「捡现成 zip」 */
export function electronCacheRoot() {
  return process.env.electron_config_cache || path.join(cacheHome(), 'electron');
}

export function zipName(version, platform = process.platform, arch = process.arch) {
  return `electron-v${String(version).replace(/^v/, '')}-${platform}-${arch}.zip`;
}

export function storeDistDir({ version, platform = process.platform, arch = process.arch }) {
  return path.join(storeRoot(), `v${String(version).replace(/^v/, '')}-${platform}-${arch}`);
}

export function electronDir(root = REPO_ROOT) {
  return path.join(root, 'node_modules', 'electron');
}

function readVersionOf(pkgDir) {
  return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let names = [];
      try {
        names = fs.readdirSync(cur);
      } catch {
        continue;
      }
      for (const n of names) stack.push(path.join(cur, n));
    } else {
      total += st.size;
    }
  }
  return total;
}

const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;

/** dist 目录内容是否"是这一版 electron 的可用二进制" */
function isDistReady(dir, version) {
  try {
    if (fs.readFileSync(path.join(dir, 'version'), 'utf8').trim() !== String(version).replace(/^v/, '')) return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dir, platformExe()));
}

/**
 * 当前 worktree 的 electron 就绪状态（只读）。
 * code：ok | not-installed | dist-missing | dist-dangling | exe-missing | version-mismatch |
 *       path-missing | dist-local（实目录，未共享）| dist-elsewhere（软链指向别处）
 */
export function electronStatus(root = REPO_ROOT) {
  const pkgDir = electronDir(root);
  if (!exists(path.join(pkgDir, 'package.json'))) return { ok: false, code: 'not-installed' };
  const version = readVersionOf(pkgDir);
  const dist = path.join(pkgDir, 'dist');

  let st = null;
  try {
    st = fs.lstatSync(dist);
  } catch {
    return { ok: false, code: 'dist-missing', version };
  }
  let link = null;
  if (st.isSymbolicLink()) {
    link = fs.readlinkSync(dist);
    try {
      fs.statSync(dist);
    } catch {
      return { ok: false, code: 'dist-dangling', version, link };
    }
  }
  if (!fs.existsSync(path.join(dist, platformExe()))) return { ok: false, code: 'exe-missing', version };
  try {
    if (fs.readFileSync(path.join(dist, 'version'), 'utf8').trim() !== version) {
      return { ok: false, code: 'version-mismatch', version };
    }
  } catch {
    return { ok: false, code: 'version-mismatch', version };
  }
  const shared = process.env.DIY_ELECTRON_SHARED !== '0';
  if (!shared) return { ok: true, code: 'ok', version };
  const target = storeDistDir({ version });
  if (!st.isSymbolicLink()) return { ok: false, code: 'dist-local', version, bytes: dirSize(dist) };
  if (path.resolve(pkgDir, link) !== target) return { ok: false, code: 'dist-elsewhere', version, link };
  return { ok: true, code: 'ok', version };
}

function readChecksums(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(electronDir(root), 'checksums.json'), 'utf8'));
  } catch {
    return null;
  }
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 本地现成的 zip：DIY_ELECTRON_ZIP、store/zips、electron 自带缓存（**每个 URL 键目录都扫**，跨镜像复用） */
function findLocalZip({ version, platform, arch, root, log }) {
  const name = zipName(version, platform, arch);
  const want = readChecksums(root)?.[name];
  const candidates = [];
  if (process.env.DIY_ELECTRON_ZIP) candidates.push(process.env.DIY_ELECTRON_ZIP);
  candidates.push(path.join(storeRoot(), 'zips', name));
  try {
    for (const d of fs.readdirSync(electronCacheRoot(), { withFileTypes: true })) {
      if (d.isDirectory()) candidates.push(path.join(electronCacheRoot(), d.name, name));
    }
  } catch {
    // 缓存根不存在：正常（从没下过）
  }
  for (const c of candidates) {
    if (!exists(c)) continue;
    if (want && sha256(c) !== want) {
      log(`本地 zip 校验不符（可能与 checksums.json 版本不一致），跳过：${c}`);
      continue;
    }
    return c;
  }
  return null;
}

/** npm 配置里的 electron_mirror（运行时没有 npm 上下文，读不到 `npm_config_*` 环境变量） */
function npmrcValue(key) {
  for (const f of [path.join(REPO_ROOT, '.npmrc'), path.join(os.homedir(), '.npmrc')]) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
      return line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

function resolveMirror() {
  return (
    process.env.ELECTRON_MIRROR ||
    process.env.DIY_ELECTRON_MIRROR ||
    process.env.npm_config_electron_mirror ||
    process.env.NPM_CONFIG_ELECTRON_MIRROR ||
    npmrcValue('electron_mirror') ||
    null
  );
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function downloadZip({ version, platform, arch, root }) {
  const { downloadArtifact } = await import('@electron/get');
  const mirror = resolveMirror();
  const timeoutMs = Number(process.env.DIY_ELECTRON_TIMEOUT_MS || 300_000);
  // 下载过程的消息**不受 --quiet 抑制**：几百 MB 静默几分钟跟卡死无法区分（这正是本脚本要消灭的症状）
  console.log(
    `[ensure-electron] 没有现成二进制 → 开始下载 electron v${version}（约 118MB，镜像 ${mirror || 'GitHub 官方'}，` +
      `超时 ${Math.round(timeoutMs / 1000)}s）…`,
  );
  const pending = downloadArtifact({
    version,
    artifactName: 'electron',
    platform,
    arch,
    // 显式传镜像：让缓存键（= 下载 URL 目录的 sha256）与 npm 安装时一致 —— 否则运行时（无
    // npm_config_electron_mirror）会走 GitHub URL，缓存里已有的 zip 也命中不了（"每次都要下载"的根因）
    mirrorOptions: mirror ? { mirror } : undefined,
    checksums: readChecksums(root) ?? undefined,
  });
  const zipPath = await withTimeout(
    pending,
    timeoutMs,
    `下载超时（${timeoutMs}ms）。重跑本脚本，或设 ELECTRON_MIRROR 用镜像 / DIY_ELECTRON_ZIP 指定本地 zip`,
  );
  console.log(`[ensure-electron] 下载完成：${zipPath}`);
  return zipPath;
}

/** 反复留痕的脏东西：`<dist>/dist` 自指软链（在已软链的目录里又跑了一次软链命令）→ realpath 会 ELOOP */
function cleanSelfLink(dir) {
  const self = path.join(dir, 'dist');
  try {
    if (fs.lstatSync(self).isSymbolicLink()) fs.unlinkSync(self);
  } catch {
    // 没有就算了
  }
}

async function extractZip(zipPath, targetDir, root) {
  const req = createRequire(path.join(electronDir(root), 'package.json'));
  const modPath = req.resolve('@electron-internal/extract-zip');
  const { extract } = await import(pathToFileURL(modPath).href);
  const tmp = `${targetDir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await extract(zipPath, { dir: tmp });
    // electron 自己的 install.js 是把 electron.d.ts 挪到包根（包 tarball 里已有一份），store 里不需要
    fs.rmSync(path.join(tmp, 'electron.d.ts'), { force: true });
    cleanSelfLink(tmp);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(tmp, targetDir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** 本 worktree 里现成的完整实目录 dist（可直接采纳进 store，零下载） */
function localCompleteDist(root, version) {
  const dist = path.join(electronDir(root), 'dist');
  try {
    const st = fs.lstatSync(dist);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch {
    return null;
  }
  return isDistReady(dist, version) ? dist : null;
}

function adoptDist(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
  cleanSelfLink(to);
}

/** 把 targetDir 弄成可用的 dist 内容：采纳本地实目录 → 本地 zip → 下载 */
async function provision({ targetDir, version, platform, arch, root, download, force, log, actions }) {
  if (!force && isDistReady(targetDir, version)) return;

  const local = localCompleteDist(root, version);
  if (local) {
    adoptDist(local, targetDir);
    actions.push(`采纳本地 dist（零下载）：${local} → ${targetDir}`);
    return;
  }

  const zip = findLocalZip({ version, platform, arch, root, log });
  if (zip) {
    await extractZip(zip, targetDir, root);
    actions.push(`从本地 zip 解压：${zip} → ${targetDir}`);
    return;
  }

  if (!download) {
    throw new Error(
      `electron v${version} 二进制未就绪（store 与本地 zip 都没有），且指定了 --no-download` +
        ` → 跑 node scripts/ensure-electron.mjs（允许下载；或设 ELECTRON_MIRROR / DIY_ELECTRON_ZIP）`,
    );
  }

  const downloaded = await downloadZip({ version, platform, arch, root });
  await extractZip(downloaded, targetDir, root);
  actions.push(`下载并解压 → ${targetDir}`);
}

function linkDist({ pkgDir, target, keepLocal, actions }) {
  const dist = path.join(pkgDir, 'dist');
  let st = null;
  try {
    st = fs.lstatSync(dist);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) {
    if (path.resolve(pkgDir, fs.readlinkSync(dist)) === target) return;
    fs.unlinkSync(dist);
  } else if (st) {
    if (keepLocal) {
      actions.push(`保留本地 dist 实目录（--keep-local / DIY_ELECTRON_KEEP_LOCAL_DIST=1）：${dist}`);
      return;
    }
    const freed = dirSize(dist);
    fs.rmSync(dist, { recursive: true, force: true });
    actions.push(`移除本地 dist 实目录（释放 ${mb(freed)}）→ 改用共享 store`);
  }
  fs.symlinkSync(target, dist, process.platform === 'win32' ? 'junction' : 'dir');
  actions.push(`软链 ${dist} → ${target}`);
}

function writePathFile(pkgDir) {
  const exe = platformExe();
  const f = path.join(pkgDir, 'path.txt');
  try {
    if (fs.readFileSync(f, 'utf8') === exe) return false;
  } catch {
    // 不存在：下面写
  }
  fs.writeFileSync(f, exe);
  return true;
}

/**
 * 确保本 worktree 的 electron 二进制可用（幂等）。
 * @returns {Promise<{version: string, actions: string[], warnings: string[]}>}
 */
export async function ensureElectron({
  root = REPO_ROOT,
  download = true,
  force = false,
  keepLocal = process.env.DIY_ELECTRON_KEEP_LOCAL_DIST === '1',
  log = () => {},
} = {}) {
  const pkgDir = electronDir(root);
  const st = electronStatus(root);
  if (st.code === 'not-installed') {
    throw new Error(`${pkgDir} 不存在 → 先装依赖：./sha.sh sync`);
  }
  if (st.ok && !force) return { version: st.version, actions: [], warnings: [] };

  const version = st.version;
  const shared = process.env.DIY_ELECTRON_SHARED !== '0';
  const platform = process.platform;
  const arch = process.arch;
  const targetDir = shared ? storeDistDir({ version, platform, arch }) : path.join(pkgDir, 'dist');
  const actions = [];
  const warnings = [];

  // dist 完好、只差 path.txt：不必碰 store（旧安装 / 手工链过 dist 的 worktree）
  if (st.code === 'path-missing') {
    if (writePathFile(pkgDir)) actions.push('补 path.txt');
    return { version, actions, warnings };
  }

  // --keep-local：实目录是用户自己的，一律不动（不采纳、不换软链）
  if (st.code === 'dist-local' && keepLocal) {
    if (writePathFile(pkgDir)) actions.push('补 path.txt');
    actions.push(`保留本地 dist 实目录：${path.join(pkgDir, 'dist')}`);
    return { version, actions, warnings };
  }

  await provision({ targetDir, version, platform, arch, root, download, force, log, actions });
  if (shared) linkDist({ pkgDir, target: targetDir, keepLocal, actions });
  if (writePathFile(pkgDir)) actions.push('补 path.txt');

  const after = electronStatus(root);
  if (!after.ok) warnings.push(`仍未就绪（${after.code}）：${pkgDir}/dist`);
  return { version, actions, warnings };
}

async function main() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes('--quiet');
  const soft = argv.includes('--soft');
  const log = (msg) => {
    if (!quiet) console.log(`[ensure-electron] ${msg}`);
  };
  try {
    const r = await ensureElectron({
      download: !argv.includes('--no-download'),
      force: argv.includes('--force'),
      keepLocal: argv.includes('--keep-local') || process.env.DIY_ELECTRON_KEEP_LOCAL_DIST === '1',
      log,
    });
    for (const a of r.actions) log(a);
    for (const w of r.warnings) console.warn(`[ensure-electron] ⚠ ${w}`);
    if (!r.actions.length) log(`已就绪（electron v${r.version}）`);
  } catch (err) {
    const msg = `[ensure-electron] ${err.message}`;
    if (soft) {
      console.warn(`${msg}\n[ensure-electron] （--soft：不阻断本次命令；真起 Electron 的入口会再要求一次）`);
      process.exit(0);
    }
    console.error(msg);
    // 下载超时后底层连接仍会挂住事件循环（@electron/get 无超时）→ 显式退出，别让它等
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
