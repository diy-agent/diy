// src/main/core/data-file.ts
// 🎯 内置数据文件（src/main/data/*.json）的**定位**：bundle 旁 / 源树 / 兜底三条候选。
//
// 为什么不 import JSON：models.dev snapshot 有 4MB、6000+ 模型，`resolveJsonModule` 会把它
// 推断成字面量类型（实例化爆炸）。故一律 fs 惰性读 —— 本模块只回答「文件在哪」。
//
// 候选路径按「bundle 所在深度」区分（见 diy/AGENTS.md 的实例四态）：
//   · build/<V>/{main,cli}/data/<name>       sha.sh build 拷贝的产物
//   · src/main/**/data 与 src/main/data      tsx 直跑
//   · build/<V>/main|cli → 源树兜底          preview/lab 不拷贝时
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 候选路径（按 bundle 所在深度列出，诊断时报全） */
function candidates(name: string): string[] {
    const here = dirname(fileURLToPath(import.meta.url));
    return [
        join(here, "data", name), // bundle 旁：build/<V>/main|cli/data（sha.sh build 拷贝）
        join(here, "../data", name), // src/main/** → src/main/data（tsx 直跑）
        join(here, "../../../src/main/data", name), // build/<V>/main|cli → 源树兜底（preview/lab 未拷贝时）
        join(here, "../../src/main/data", name), // src/cli/** → src/main/data（tsx 直跑 CLI）
    ];
}

/** 定位内置数据文件；都不存在 → null（调用方决定报错还是降级） */
export function dataFile(name: string): string | null {
    return candidates(name).find((c) => existsSync(c)) ?? null;
}

/** 同上，但缺失即 fail-fast 报错（列出所有候选路径，便于诊断） */
export function dataFileOrThrow(name: string): string {
    const p = dataFile(name);
    if (!p) throw new Error(`${name} 缺失: ${candidates(name).join(" | ")}`);
    return p;
}
