// src/main/core/app-root.ts
// 🎯 包根（`build/` 的父目录 = `pkgs.ts/diy-app`）定位：CLI 据它 spawn GUI 产物。
//
// 为什么单独成文件并测：**源码与产物的相对深度不同** ——
//   源码模式 `src/cli/index.ts`          → 包根下 2 级
//   产物模式 `build/<variant>/cli/index.js` → 包根下 4 级
// 旧实现固定数 4 次 dirname（只对产物成立）：`DIY_CLI_MODE=tsx` 直跑源码时算到 `pkgs.ts/`，
// spawn 报「diy 管控台未构建: <repo>/pkgs.ts/build/preview/main/index.mjs」（实测，少了 diy-app）。
// 判据改为**包标记**（`package.json`）逐级上溯 —— 与文件放在哪一层无关，两种模式同一份代码。
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 包根标记。npm 打包（`files` 只含 `bin/`+`build/prod/`）也必带 package.json，故产物安装同样成立 */
const MARKER = "package.json";
/** 上溯层数上限：产物模式最深 4 层到包根，留余量 */
const MAX_DEPTH = 8;

/**
 * 从**模块文件路径**（`fileURLToPath(import.meta.url)`）上溯定位包根；找不到就抛（不猜错路径）。
 * `exists` 可注入 —— 单测据此脱离真实文件系统。
 */
export function resolveAppRoot(from: string, exists: (p: string) => boolean = existsSync): string {
    let dir = dirname(resolve(from));
    for (let i = 0; i < MAX_DEPTH; i++) {
        if (exists(join(dir, MARKER))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break; // 到文件系统根
        dir = parent;
    }
    throw new Error(
        `找不到包根：从 ${from} 上溯 ${MAX_DEPTH} 层未见 ${MARKER}（源码树与 npm 包都应带上它）`,
    );
}
