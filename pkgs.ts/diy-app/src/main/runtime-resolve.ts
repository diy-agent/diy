// src/main/runtime-resolve.ts
// 🎯 能力包运行时解析（##455，薄壳子准备 #3）：证明 Electron 能按名字加载 `@diy-agent/*`。
//
// 两个形态共用一个锚点：
//   开发态：`pkgs.ts/diy-app/runtime/`（scripts/build-runtime.mjs 生成，脚本 cp 到这里）
//   打包态：`<Resources>/runtime/`（electron-builder.yml 的 extraResources 挂载）
//
// 本模块**不接业务 import** —— 只提供 runtimeRequire() / loadPackage()，供后续 loader 使用。
// 判定全收敛在 runtimeDir() 一个函数里，别把路径散落到调用方。

import { InvariantError } from "@diy-agent/context/format/invariant";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Electron 主进程才有 resourcesPath；纯 node（脚本 / 单测）下为 undefined */
interface MaybeElectronProcess {
    resourcesPath?: string;
}

const selfDir = dirname(fileURLToPath(import.meta.url)); // 开发态构建产物：build/<variant>/main

/** 候选目录（按优先级）：显式环境变量 > 打包 Resources > 构建产物旁(../../..) > src/main 旁(../..) */
function candidates(): string[] {
    const out: string[] = [];
    const fromEnv = process.env.DIY_RUNTIME_DIR;
    if (fromEnv) out.push(fromEnv);
    const resourcesPath = (process as unknown as MaybeElectronProcess).resourcesPath;
    if (resourcesPath) out.push(resolve(resourcesPath, "runtime"));
    out.push(resolve(selfDir, "../../../runtime")); // build/<variant>/main → pkgs.ts/diy-app/runtime
    out.push(resolve(selfDir, "../../runtime")); // src/main（tsx 直跑源码）→ pkgs.ts/diy-app/runtime
    return out;
}

/** 定位 runtime/ 目录：第一个含 package.json 的候选；全缺则报错（列出查过哪里，便于排障） */
export function runtimeDir(): string {
    const tried = candidates();
    for (const dir of tried) {
        if (existsSync(resolve(dir, "package.json"))) return dir; // sync-io-ok: runtime 锚点是 createRequire 的同步前置（启动早期一次探测）
    }
    throw new InvariantError(
        "fs/not-found",
        `runtime/ 未找到（候选：${tried.join(", ")}）—— 开发态先跑 node scripts/build-runtime.mjs；打包态检查 extraResources`,
    );
}

/** 以 runtime/ 为锚点的 require：resolve() 走 runtime/node_modules 与各包 exports */
export function runtimeRequire(): NodeJS.Require {
    return createRequire(resolve(runtimeDir(), "package.json"));
}

/** 按包名解析入口的绝对路径（ESM 用 file URL 再 import） */
export function resolvePackage(name: string): string {
    return runtimeRequire().resolve(name);
}

/** 按包名加载（ESM）—— 调用方拿到真实模块，证明链路通 */
export async function loadPackage(name: string): Promise<unknown> {
    const { pathToFileURL } = await import("node:url");
    return import(pathToFileURL(resolvePackage(name)).href);
}
