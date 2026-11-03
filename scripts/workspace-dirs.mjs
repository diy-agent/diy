// scripts/workspace-dirs.mjs —— 仓内所有 workspace 目录（含 package.json 的目录）的唯一发现口径
//
// 布局（##512 重组后）：
//   pkgs.ts/<组>/<包>   基础设施 / 对话内核 / 模型 / 远程 / UI（**两层**）
//   pkgs.ts/flow        例外：单包分组，留在 pkgs.ts 根（一层）
//   pkgs.ts/room        同上
//   apps/<app>          可执行应用（一层）
//
// 为什么单独成文件：build-order / gen-tsconfig-build-all / check-sync / changed-plan /
// related-tests / npm-publish-common 六处各自 `readdirSync('pkgs.ts')` 只认一层，
// 重组后全都会静默漏包 —— 收成一处，下次再动布局只改这里。
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isDir = (p) => {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
};

/** 子目录列表（只认目录，忽略点开头） */
function subdirs(dir) {
    if (!isDir(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
}

/**
 * 仓内 workspace 目录（仓相对路径，排序后）。
 * @param {string} [root] 仓根，缺省为脚本所在仓
 */
export function workspaceDirs(root = REPO_ROOT) {
    const out = [];
    const pkgs = join(root, "pkgs.ts");
    for (const name of subdirs(pkgs)) {
        const groupAbs = join(pkgs, name);
        if (existsSync(join(groupAbs, "package.json"))) out.push(`pkgs.ts/${name}`);
        // 再下一层：分组目录下的真包
        for (const pkg of subdirs(groupAbs)) {
            if (existsSync(join(groupAbs, pkg, "package.json"))) out.push(`pkgs.ts/${name}/${pkg}`);
        }
    }
    for (const name of subdirs(join(root, "apps"))) {
        if (existsSync(join(root, "apps", name, "package.json"))) out.push(`apps/${name}`);
    }
    return out.sort();
}
