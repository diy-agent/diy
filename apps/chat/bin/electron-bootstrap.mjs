// bin/electron-bootstrap.mjs — 「Electron 二进制」从无到有的唯一实现（发行 CLI 与仓内 dev 共用）。
//
// 为什么不用 `require('electron')` 的惰性下载（2026-10-30 c-mac 实测，##478）：
//   electron 43 的 package.json **没有 postinstall**，二进制由 `node_modules/electron/index.js`
//   在 `require()` 时下载，且是 `@electron/get` 的**无超时、无进度、无中间输出**下载：
//   118MB 全程只打印一行 "Downloading Electron binary..." ⇒ 用户无法判断是慢还是挂死
//   （实测冷启动 60s 内零输出，非常容易误判成网络不行）。
//   镜像也只有 `ELECTRON_MIRROR` 一个，挂了就干等。
//
// 本模块的约定（判据见 ##478）：
//   ① 每个阶段**先打印再干活**（检查 → 探测 → 下载 → 校验 → 解压 → 启动），任何阶段静默 ≤ 2s；
//   ② 候选镜像**并发探测**（Promise.all + 各自 AbortSignal.timeout(3000)），逐个输出 ✓/✗ + 毫秒；
//   ③ 选**响应最快**的可用源；`ELECTRON_MIRROR` 已设 ⇒ 用户优先，但仍探测一遍并报告实测耗时；
//   ④ 下载带进度（百分比 / 速度 / ETA），非 TTY（CI / 重定向）也至少每 2s 打一行；
//   ⑤ 二进制落在**全机共享 store**（`<cache>/diy/electron/v<ver>-<platform>-<arch>`），
//      跨 `npm i -g` 重装 / 多个安装并存都只下一次。
//
// 环境变量：
//   ELECTRON_MIRROR / DIY_ELECTRON_MIRROR   用户指定镜像（优先，但会实测）
//   DIY_ELECTRON_STORE                       store 根（缺省 <cache>/diy/electron）
//   DIY_ELECTRON_ZIP                         本地 zip（离线分发）
//   DIY_ELECTRON_TIMEOUT_MS                  下载总超时（缺省 600000 = 10 分钟）
//   DIY_ELECTRON_PROBE_TIMEOUT_MS            单个镜像探测超时（缺省 3000）
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 平台 → dist 内的可执行文件相对路径（与 electron/install.js 的 getPlatformPath 同口径） */
const EXE_REL = {
    darwin: "Electron.app/Contents/MacOS/Electron",
    mas: "Electron.app/Contents/MacOS/Electron",
    linux: "electron",
    freebsd: "electron",
    openbsd: "electron",
    win32: "electron.exe",
};

export function platformExe(platform = process.platform) {
    const exe = EXE_REL[platform];
    if (!exe) throw new Error(`electron 不支持平台 ${platform}`);
    return exe;
}

/** 各平台的用户缓存根（macOS 是 ~/Library/Caches，其余 XDG） */
export function cacheHome() {
    if (process.env["XDG_CACHE_HOME"]) return process.env["XDG_CACHE_HOME"];
    return process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches")
        : path.join(os.homedir(), ".cache");
}

export function storeRoot() {
    return process.env["DIY_ELECTRON_STORE"] || path.join(cacheHome(), "diy", "electron");
}

export function zipName(version, platform = process.platform, arch = process.arch) {
    return `electron-v${String(version).replace(/^v/, "")}-${platform}-${arch}.zip`;
}

export function electronStoreDir({ version, platform = process.platform, arch = process.arch }) {
    return path.join(storeRoot(), `v${String(version).replace(/^v/, "")}-${platform}-${arch}`);
}

const normalizeMirror = (mirror) => (mirror.endsWith("/") ? mirror : `${mirror}/`);

/**
 * 候选镜像。`kind: "mirror"` 走 `@electron/get` 的镜像约定 `<base>v<version>/<zip>`；
 * `kind: "github"` 是官方 release（没有镜像前缀，路径也固定）。
 */
export const DEFAULT_MIRRORS = [
    { id: "npmmirror", label: "npmmirror", kind: "mirror", base: "https://npmmirror.com/mirrors/electron/" },
    { id: "npmmirror-cdn", label: "npmmirror-cdn", kind: "mirror", base: "https://cdn.npmmirror.com/binaries/electron/" },
    { id: "github", label: "github", kind: "github" },
];

/** 镜像 → 该版本 zip 的下载 URL */
export function mirrorUrl(mirror, { version, zip }) {
    const v = `v${String(version).replace(/^v/, "")}`;
    if (mirror.kind === "github") return `https://github.com/electron/electron/releases/download/${v}/${zip}`;
    return `${normalizeMirror(mirror.base)}${v}/${zip}`;
}

/** 用户指定的镜像（环境变量优先于缺省清单）；没设则 null */
export function requestedMirror() {
    const raw = process.env["ELECTRON_MIRROR"] || process.env["DIY_ELECTRON_MIRROR"];
    if (!raw) return null;
    return { id: "user", label: "你指定的", kind: "mirror", base: normalizeMirror(raw.trim()) };
}

/**
 * 并发探测所有镜像（**不是串行**：串行 3 个源最坏要等 3×超时）。
 * @returns {Promise<Array<{id: string, label: string, url: string, ok: boolean, ms: number, status?: number, error?: string, total?: number}>>}
 */
export async function probeMirrors({ mirrors, version, zip, timeoutMs = 3000, fetchImpl = fetch }) {
    const jobs = mirrors.map(async (mirror) => {
        const url = mirrorUrl(mirror, { version, zip });
        const started = Date.now();
        try {
            const signal = AbortSignal.timeout(timeoutMs);
            // HEAD 最省流量；少数镜像不支持 HEAD（405/403），退回 Range 请求只取 1 字节
            let res = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal });
            if (!res.ok && res.status !== 405 && res.status !== 403) {
                res = await fetchImpl(url, { headers: { Range: "bytes=0-0" }, redirect: "follow", signal });
            }
            if (!res.ok && res.status !== 206) {
                return { id: mirror.id, label: mirror.label, url, ok: false, ms: Date.now() - started, status: res.status, error: `HTTP ${res.status}` };
            }
            // 顺手记下内容长度（进度条要用，省一次往返）
            const total = Number(res.headers.get("content-length") ?? 0) || 0;
            return { id: mirror.id, label: mirror.label, url, ok: true, ms: Date.now() - started, status: res.status, total };
        } catch (cause) {
            const ms = Date.now() - started;
            const timeout = cause?.name === "TimeoutError" || cause?.name === "AbortError";
            return { id: mirror.id, label: mirror.label, url, ok: false, ms, error: timeout ? "超时" : String(cause?.cause?.code ?? cause?.message ?? cause) };
        }
    });
    // Promise.all：全部同时起跑；输出顺序 = 候选顺序（对照起来方便）
    return Promise.all(jobs);
}

/**
 * 从探测结果里挑下载源。
 * `ELECTRON_MIRROR` 已设 ⇒ 用户优先（但它自己不通时回落最快可用源，并说明原因）。
 * @returns {{ chosen: object | null, reason: string }}
 */
export function chooseMirror(results, userWanted) {
    const ok = results.filter((r) => r.ok);
    const fastest = ok.slice().sort((a, b) => a.ms - b.ms)[0] ?? null;
    if (userWanted) {
        const mine = results.find((r) => r.id === "user");
        if (mine?.ok) return { chosen: mine, reason: `按你指定的 ELECTRON_MIRROR（实测 ${mine.ms}ms）` };
        if (fastest) {
            return { chosen: fastest, reason: `你指定的镜像不可用（${mine?.error ?? "未探测"}），回落到最快的 ${fastest.label}（${fastest.ms}ms）` };
        }
        return { chosen: null, reason: "你指定的镜像与所有候选都不可用" };
    }
    if (!fastest) return { chosen: null, reason: "所有候选镜像都不可用" };
    return { chosen: fastest, reason: `选最快的 ${fastest.label}（${fastest.ms}ms）` };
}

/** `[====>       ] 28%  1.2MB/s  ETA 90s` —— 纯函数，便于测试 */
export function formatProgress({ done, total, elapsedMs, width = 16 }) {
    const ratio = total > 0 ? Math.min(done / total, 1) : 0;
    const filled = Math.round(ratio * width);
    const bar = `${"=".repeat(Math.max(filled - 1, 0))}${filled > 0 ? ">" : ""}${" ".repeat(Math.max(width - filled, 0))}`;
    const percent = total > 0 ? `${Math.floor(ratio * 100)}%` : `${Math.round(done / 1024 / 1024)}MB`;
    const speed = elapsedMs > 0 ? done / 1024 / 1024 / (elapsedMs / 1000) : 0;
    // 头几百 KB 的速度是噪声（分母极小）：此时只报已下多少，别给一个 6000s 的假 ETA
    const eta = speed > 0 && total > done && done > 1024 * 1024 ? `ETA ${Math.ceil((total - done) / 1024 / 1024 / speed)}s` : "";
    return `  [${bar}] ${percent}  ${speed.toFixed(1)}MB/s${eta ? `  ${eta}` : ""}`;
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** 下载 zip 到目标文件，途中按进度输出（TTY 单行覆盖，非 TTY 每 2s 一行）—— dev 脚本也复用它 */
export async function downloadZipFile({ url, dest, totalHint, fetchImpl = fetch, log, timeoutMs, tickMs = 250 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    const isTTY = Boolean(process.stdout.isTTY);
    const total = totalHint || 0;
    let done = 0;
    let lastPrint = 0;
    const print = (force) => {
        const now = Date.now();
        if (!force && now - lastPrint < (isTTY ? tickMs : 2000)) return;
        lastPrint = now;
        const line = formatProgress({ done, total, elapsedMs: now - started });
        if (isTTY) process.stdout.write(`\r${line}`);
        else log(line.trimEnd());
    };
    let stream;
    try {
        const res = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}（${url}）`);
        stream = fs.createWriteStream(dest);
        for await (const chunk of res.body) {
            done += chunk.length;
            if (!stream.write(Buffer.from(chunk))) await new Promise((r) => stream.once("drain", r));
            print(false);
        }
    } finally {
        clearTimeout(timer);
        if (stream) await new Promise((resolve) => stream.end(resolve));
        if (isTTY) process.stdout.write(`\r${" ".repeat(64)}\r`);
    }
    print(true);
    if (isTTY) process.stdout.write("\n");
    return { bytes: done, elapsedMs: Date.now() - started };
}

/** 读 electron 包自带的 checksums.json（有的版本没有 → null） */
function readChecksums(electronDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(electronDir, "checksums.json"), "utf8"));
    } catch {
        return null;
    }
}

function distReady(dir, version) {
    try {
        if (fs.readFileSync(path.join(dir, "version"), "utf8").trim() !== String(version).replace(/^v/, "")) return false;
    } catch {
        return false;
    }
    return fs.existsSync(path.join(dir, platformExe()));
}

async function extractZip(zip, targetDir, electronDir, log = () => {}) {
    const req = createRequire(path.join(electronDir, "package.json"));
    const { extract } = await import(pathToFileURL(req.resolve("@electron-internal/extract-zip")).href);
    const tmp = `${targetDir}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    // 解压 300MB 要 3~15s：中间打个心跳，「静默 ≤ 2s」对解压同样成立
    const started = Date.now();
    const ticker = setInterval(() => log(`  解压中… 已 ${Math.round((Date.now() - started) / 1000)}s`), 2000);
    try {
        await extract(zip, { dir: tmp });
        // electron 自己的 install.js 也这么做：包根已有一份 electron.d.ts，store 里不需要
        fs.rmSync(path.join(tmp, "electron.d.ts"), { force: true });
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(tmp, targetDir);
    } catch (cause) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw cause;
    } finally {
        clearInterval(ticker);
    }
}

/**
 * 确保某版本的 electron 二进制可用，返回可直接 spawn 的可执行文件路径。
 *
 * @param {object} opts
 * @param {string} opts.version        electron 版本（读自 node_modules/electron/package.json）
 * @param {string} opts.electronDir    node_modules/electron（取 checksums / extract-zip / 现成 dist）
 * @param {(msg: string) => void} opts.log
 * @returns {Promise<{exe: string, dir: string, source: string}>}
 */
/**
 * **只查不下载**：现成可用的可执行文件（store → 本包自己的 dist），没有则 null。
 * `diy-chat electron --check` 用它（判据：只报告状态，绝不触发网络）。
 */
export function locateElectronBinary({ version, electronDir, platform = process.platform, arch = process.arch }) {
    const exeRel = platformExe(platform);
    const storeDir = electronStoreDir({ version, platform, arch });
    for (const [dir, source] of [
        [storeDir, "store"],
        [path.join(electronDir, "dist"), "node_modules"],
    ]) {
        if (distReady(dir, version)) return { exe: path.join(dir, exeRel), dir, source };
    }
    return null;
}

/** 上线前一刻的日志行：`检查 Electron 二进制（v…）` */
export async function ensureElectronBinary({
    version,
    electronDir,
    platform = process.platform,
    arch = process.arch,
    log = () => {},
    fetchImpl = fetch,
    probeTimeoutMs = Number(process.env["DIY_ELECTRON_PROBE_TIMEOUT_MS"] || 3000),
    downloadTimeoutMs = Number(process.env["DIY_ELECTRON_TIMEOUT_MS"] || 600_000),
} = {}) {
    const zip = zipName(version, platform, arch);
    const exeRel = platformExe(platform);
    const storeDir = electronStoreDir({ version, platform, arch });

    // ① 现成的：store → 本包自己的 dist（npm 安装时可能已带 / 已下）
    log(`检查 Electron 二进制（v${version}，${platform}-${arch}）...`);
    const located = locateElectronBinary({ version, electronDir, platform, arch });
    if (located) {
        log(`✓ 已就绪（${located.source}）：${located.dir}`);
        return located;
    }
    log("未找到，准备下载（约 120MB；只下一次，之后全机复用）");

    // ② 离线 zip（内网 / 可复现环境）
    const zipOverride = process.env["DIY_ELECTRON_ZIP"];
    const expected = readChecksums(electronDir)?.[zip];

    if (zipOverride) {
        log(`使用本地 zip：${zipOverride}`);
        await extractZip(zipOverride, storeDir, electronDir, log);
        if (!distReady(storeDir, version)) throw new Error(`本地 zip 解压后仍不可用：${storeDir}`);
        log(`✓ 解压完成 → ${storeDir}`);
        return { exe: path.join(storeDir, exeRel), dir: storeDir, source: "local-zip" };
    }

    // ③ 并发探测镜像
    const wanted = requestedMirror();
    const mirrors = wanted ? [wanted, ...DEFAULT_MIRRORS] : DEFAULT_MIRRORS;
    log(`探测镜像（并发，各 ${probeTimeoutMs / 1000}s 超时）...`);
    const results = await probeMirrors({ mirrors, version, zip, timeoutMs: probeTimeoutMs, fetchImpl });
    for (const r of results) {
        log(`  ${r.ok ? "✓" : "✗"} ${r.label.padEnd(14)}${r.ok ? `${r.ms}ms` : `${r.error}（${r.ms}ms）`}`);
    }
    const { chosen, reason } = chooseMirror(results, wanted);
    if (!chosen) {
        throw new Error(
            [
                "所有 Electron 镜像都不可用（网络不通 / 被墙 / 镜像挂了）",
                ...results.map((r) => `  ✗ ${r.label} ${r.url}：${r.error}`),
                "手动下载后用本地 zip 离线安装：",
                `  curl -L -o /tmp/${zip} ${mirrorUrl(DEFAULT_MIRRORS[0], { version, zip })}`,
                `  DIY_ELECTRON_ZIP=/tmp/${zip} diy-chat`,
                "或指定镜像：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ diy-chat",
            ].join("\n"),
        );
    }
    log(`→ 使用 ${chosen.label}：${reason}`);

    // ④ 下载（失败可回落下一个源：用户源挂了 / 校验不通过）
    const zipPath = path.join(storeDir, "..", zip);
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    const fallbacks = results.filter((r) => r.ok && r.id !== chosen.id).sort((a, b) => a.ms - b.ms);
    let lastError;
    for (const candidate of [chosen, ...fallbacks]) {
        try {
            log(`下载 ${zip}（自 ${candidate.label}）...`);
            const { bytes, elapsedMs } = await downloadZipFile({
                url: candidate.url,
                dest: zipPath,
                totalHint: candidate.total,
                fetchImpl,
                log,
                timeoutMs: downloadTimeoutMs,
            });
            log(`✓ 下载完成：${(bytes / 1024 / 1024).toFixed(1)}MB / ${(elapsedMs / 1000).toFixed(1)}s`);
            if (expected) {
                log("校验 sha256...");
                const actual = sha256(zipPath);
                if (actual !== expected) throw new Error(`sha256 不符（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
                log("✓ 校验通过");
            }
            log("解压中（约 300MB，视磁盘 3~15s）...");
            const started = Date.now();
            await extractZip(zipPath, storeDir, electronDir, log);
            if (!distReady(storeDir, version)) throw new Error(`解压后仍不可用：${storeDir}`);
            fs.rmSync(zipPath, { force: true });
            log(`✓ 解压完成（${((Date.now() - started) / 1000).toFixed(1)}s）→ ${storeDir}`);
            return { exe: path.join(storeDir, exeRel), dir: storeDir, source: candidate.label };
        } catch (cause) {
            lastError = cause;
            log(`✗ ${candidate.label} 失败：${cause instanceof Error ? cause.message : cause}`);
        }
    }
    throw new Error(`Electron 二进制获取失败：${lastError instanceof Error ? lastError.message : lastError}`);
}
