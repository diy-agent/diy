#!/usr/bin/env node
// scripts/ensure-merge-driver.mjs —— 注册 `merge=ours` 驱动（幂等，本仓库本地配置）
//
// 为什么需要：`pkgs.ts/*/tsconfig.build.json` 是**生成物**（scripts/gen-tsconfig-build-all.mjs
// 补 composite + references）。两边各自重新生成就会冲突，而冲突的正确解法永远是"取本侧、再跑生成器"
// —— 手解只会解错（把人家的 reference 删掉，之后 tsc -b 报 `Referenced project must have composite`）。
//
// 所以：.gitattributes 里给这类文件标 `merge=ours`，本脚本保证 driver 已配置（否则 git 无视该标记）。
// 冲突发生时：git 直接取本侧那份（不报冲突），随后 `./sha.sh check` 的生成器校验会把它补齐。
import { execFileSync } from "node:child_process";

const KEY = "merge.ours.driver";
const read = () => {
    try {
        return execFileSync("git", ["config", "--get", KEY], { encoding: "utf8" }).trim();
    } catch {
        return "";
    }
};
if (read() === "true") process.exit(0);
try {
    execFileSync("git", ["config", KEY, "true"], { stdio: "ignore" });
    console.log(`✓ 已注册 ${KEY}=true（tsconfig.build.json 冲突时自动取本侧）`);
} catch (e) {
    console.warn(`warn: 注册 ${KEY} 失败（不影响构建，只是合并时还要手解生成物冲突）：`, e.message);
}
