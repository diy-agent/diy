#!/usr/bin/env node
// bin/diy-chat — `npx @diy-agent/app-chat` / `diy-chat` 的**唯一**入口（##478 补充决策）。
//
// 为什么单 bin + 子命令（用户 2026-10-30 拍板）：
//   npx 对一个包只有一个 bin 时会自动选中，`npx @diy-agent/app-chat` 天然成立；
//   再加 `install-electron` 之类的第二个 bin，用户就得多记一个名字，而它本来只是同一件事的入口。
//   功能用子命令分裂，入口名永远只有一个。
//
//   diy-chat                    启动应用（缺二进制则先并发探测镜像 + 带进度下载）
//   diy-chat electron           只准备/修复 Electron 二进制
//   diy-chat electron --check   只检查是否就绪，不下载（未就绪 exit 1）
//   diy-chat --version          版本（含 electron 版本）
//   diy-chat --help             帮助
//
// 环境变量：ELECTRON_MIRROR / DIY_ELECTRON_ZIP / DIY_ELECTRON_STORE / DIY_VARIANT=lab 开 CDP
// 二进制逻辑全在 ./electron-bootstrap.mjs（与仓内 scripts/ensure-electron.mjs 共用一份）。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectronBinary, locateElectronBinary } from "./electron-bootstrap.mjs";

const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/bin
const pkgRoot = join(here, "..");
const mainFile = join(pkgRoot, "build", "main", "index.mjs");

const readVersion = () => {
    try {
        return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
    } catch {
        return "unknown";
    }
};

const HELP = `diy-chat — @diy-agent/app-chat 的入口

用法：
  diy-chat                      启动应用
  diy-chat electron             准备 / 修复 Electron 二进制（并发探测镜像 + 下载进度）
  diy-chat electron --check     只检查二进制是否就绪，不下载（未就绪 exit 1）
  diy-chat --version            版本（含 electron 版本）
  diy-chat --help               这份帮助

环境变量：
  ELECTRON_MIRROR=<url>         指定下载镜像（优先，但仍会实测耗时并打印）
  DIY_ELECTRON_ZIP=<zip>        用本地 zip 离线安装
  DIY_ELECTRON_STORE=<dir>      二进制共享 store（缺省 <cache>/diy/electron）
  DIY_VARIANT=lab               主进程开 CDP（9222，或 DIY_CDP_PORT）
`;

/**
 * 解析 argv（纯函数，便于测试）。
 * @returns {{kind: "help"|"version"|"electron"|"launch", check: boolean, mirror?: string, zip?: string, passthrough: string[]}}
 */
export function parseArgs(argv) {
    const out = { kind: "launch", check: false, passthrough: [] };
    let i = 0;
    const first = argv[0];
    if (first === "help" || first === "--help" || first === "-h") return { ...out, kind: "help" };
    if (first === "--version" || first === "-v" || first === "version") return { ...out, kind: "version" };
    if (first === "electron") {
        out.kind = "electron";
        i = 1;
    }
    for (; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") return { ...out, kind: "help" };
        if (arg === "--check") out.check = true;
        else if (arg.startsWith("--mirror=")) out.mirror = arg.slice("--mirror=".length);
        else if (arg.startsWith("--zip=")) out.zip = arg.slice("--zip=".length);
        else out.passthrough.push(arg); // 其余原样交给 electron（如 --remote-debugging-port=9000）
    }
    return out;
}

const log = (msg) => console.log(`[diy-chat] ${msg}`);

/** 解析 electron 包位置与版本（找不到就报清楚怎么修） */
function resolveElectron() {
    try {
        const require = createRequire(import.meta.url);
        const dir = dirname(require.resolve("electron"));
        const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
        return { dir, version };
    } catch {
        return null;
    }
}

/**
 * 入口主逻辑。返回退出码（0 = 成功）。
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.kind === "help") {
        console.log(HELP);
        return 0;
    }

    const electron = resolveElectron();
    if (args.kind === "version") {
        console.log(`@diy-agent/app-chat ${readVersion()}`);
        console.log(`electron ${electron?.version ?? "（未安装）"}`);
        return 0;
    }
    if (!electron) {
        console.error("✗ 找不到 electron 包（依赖没装上）：npm i -g @diy-agent/app-chat@latest");
        return 1;
    }
    // --mirror / --zip：等价于对应环境变量（命令行优先）
    if (args.mirror) process.env["ELECTRON_MIRROR"] = args.mirror;
    if (args.zip) process.env["DIY_ELECTRON_ZIP"] = args.zip;

    if (args.kind === "electron") {
        if (args.check) {
            const found = locateElectronBinary({ version: electron.version, electronDir: electron.dir });
            if (found) {
                log(`✓ Electron v${electron.version} 已就绪（${found.source}）：${found.dir}`);
                return 0;
            }
            log(`✗ Electron v${electron.version} 未就绪（store 与 node_modules/electron/dist 都没有）`);
            log("  需要下载就跑：diy-chat electron");
            return 1;
        }
        const ready = await ensureElectronBinary({ version: electron.version, electronDir: electron.dir, log }).catch((cause) => {
            console.error(`✗ ${cause instanceof Error ? cause.message : cause}`);
            return null;
        });
        if (!ready) return 1;
        log(`✓ 就绪（${ready.source}）：${ready.exe}`);
        return 0;
    }

    if (!existsSync(mainFile)) {
        console.error(`✗ 缺少主进程产物：${mainFile}\n  这个包安装不完整，重装：npm i -g @diy-agent/app-chat@latest`);
        return 1;
    }
    log(`@diy-agent/app-chat ${readVersion()}`);
    const ready = await ensureElectronBinary({ version: electron.version, electronDir: electron.dir, log }).catch((cause) => {
        console.error(`✗ Electron 准备失败：${cause instanceof Error ? cause.message : cause}`);
        return null;
    });
    if (!ready) return 1;

    log("启动应用...");
    return new Promise((resolve) => {
        const child = spawn(ready.exe, [mainFile, ...args.passthrough], {
            stdio: "inherit",
            // DIY_CLI 自证：入口报的必须是「跑的是谁」（与 pkgs.ts/diy-app/bin/diy 同口径）
            env: { ...process.env, DIY_CLI: process.argv[1] ?? "diy-chat" },
        });
        child.on("error", (cause) => {
            console.error(`✗ 启动 Electron 失败（${ready.exe}）：${cause.message}`);
            resolve(1);
        });
        child.on("close", (code, signal) => {
            if (signal) process.kill(process.pid, signal);
            else resolve(code ?? 0);
        });
    });
}

/**
 * 是否「被当作脚本直接执行」。
 * 必须比 realpath：npm 装出来的 bin 是**软链**（<prefix>/bin/diy-chat → …/bin/diy-chat.mjs），
 * 直接比 `pathToFileURL(process.argv[1])` 会不相等 —— 症状是「装完运行 diy-chat 什么都不发生」（##478 实测）。
 */
function isEntryPoint() {
    const arg = process.argv[1];
    if (!arg) return false;
    try {
        return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntryPoint()) {
    process.exitCode = await main();
}
