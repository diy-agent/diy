// src/main/core/data-file.ts
// 🎯 内置数据文件（src/main/data/*.json）的**定位**：$DIY_HOME / bundle 旁 / 源树三条候选。
//
// 为什么不 import JSON：models.dev snapshot 有 4MB、6000+ 模型，`resolveJsonModule` 会把它
// 推断成字面量类型（实例化爆炸）。故一律 fs 惰性读 —— 本模块只回答「文件在哪」。
//
// 候选路径（顺序即优先级，见 diy/AGENTS.md 的实例四态）：
//   · $DIY_HOME/data/<name>                  应用内刷新**写这里**（##385）——
//                                            用户/应用更新过的数据必须压过发行快照
//   · build/<V>/{main,cli}/data/<name>       sha.sh build 拷贝的产物
//   · src/main/**/data 与 src/main/data      tsx 直跑
//   · build/<V>/main|cli → 源树兜底          lab 不拷贝时
//
// 为什么最高优先级是 `$DIY_HOME`（##385 的根因）：应用内刷新**需要一个可写落点**，
// 而 bundle 旁是只读发行物、源树是仓库（写了就 git 脏、且 lab/prod 共享同一份源树）。
// 没有这一层，模型目录刷新只能「改代码 / 重新构建」—— 那正是要消灭的形态。
//
// 诊断必须能说出**实际命中哪一份**（`dataFileHit` 带 source；`diy doctor` 直接用），
// 否则又是「只见结果不见因」（##338 / ##372 同族病）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { diyHome } from "./state";
import type { DataFileSource } from "../../shared/model-config";

/** 候选来源（诊断出口报给人看的「这份数据从哪来」）—— 单一真源在 shared/model-config.ts */
export type { DataFileSource };

export interface DataFileHit {
    /** 实际命中的绝对路径 */
    path: string;
    /** 命中哪一层（见文件头的候选顺序） */
    source: DataFileSource;
}

/** `$DIY_HOME/data/<name>`：应用内刷新（定时 / 手工按钮）的唯一写落点 */
export function dataHomeFile(name: string, home: string = diyHome()): string {
    return join(home, "data", name);
}

/** 候选路径（按优先级列出，**顺序即优先级**；诊断时全部列出便于排查） */
export function dataFileCandidates(name: string, home: string = diyHome()): DataFileHit[] {
    const here = dirname(fileURLToPath(import.meta.url));
    return [
        { path: dataHomeFile(name, home), source: "diy-home" }, // 应用内刷新写的用户数据根
        { path: join(here, "data", name), source: "bundle" }, // bundle 旁：build/<V>/main|cli/data（sha.sh build 拷贝）
        { path: join(here, "../data", name), source: "source-tree" }, // src/main/** → src/main/data（tsx 直跑）
        { path: join(here, "../../../src/main/data", name), source: "source-tree" }, // build/<V>/main|cli → 源树兜底（lab 未拷贝时）
        { path: join(here, "../../src/main/data", name), source: "source-tree" }, // src/cli/** → src/main/data（tsx 直跑 CLI）
    ];
}

/** 定位内置数据文件（含来源）；都不存在 → null（调用方决定报错还是降级） */
export function dataFileHit(name: string, home: string = diyHome()): DataFileHit | null {
    return dataFileCandidates(name, home).find((c) => existsSync(c.path)) ?? null;
}

/** 定位内置数据文件；都不存在 → null */
export function dataFile(name: string, home?: string): string | null {
    return dataFileHit(name, home)?.path ?? null;
}

/** 同上，但缺失即 fail-fast 报错（列出所有候选路径，便于诊断） */
export function dataFileOrThrow(name: string, home?: string): string {
    const p = dataFile(name, home);
    if (!p) {
        throw new Error(
            `${name} 缺失: ${dataFileCandidates(name, home)
                .map((c) => c.path)
                .join(" | ")}`,
        );
    }
    return p;
}
