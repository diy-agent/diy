// src/main/core/cost-windows.ts
// 🎯 diy 扩展层（`src/main/data/models.dev.diy.json`）的加载：进程内缓存一次。
//
// 失败语义（承 `calendars.ts` 与「不可测 ≠ 0」）：
//   · 文件缺失 / 结构非法 → **空表**（不抛错锁死启动）→ 引用时段表的档一律不命中（退 base 价）
//   · 单张表的某段非法 → 丢该段 + 告警（一张表坏一段，不该把整个模型目录拖死）
// 宁可算 base 价（可解释），不可静默按错的峰价收钱。
import { readFileSync } from "node:fs";
import {
    ModelsDevDiyFileSchema,
    resolveWindow,
    windowSummary,
    type WindowTable,
} from "../../shared/cost-windows";
import { MODELS_DEV_DIY_FILE, type WindowChoice } from "../../shared/model-config";
import { dataFile } from "./data-file";

interface Loaded {
    windows: WindowTable;
    /** 加载/展开期的告警（启动时打一次；也让 `llmConfig costs` 能报给 agent） */
    issues: string[];
}

let _loaded: Loaded | null = null;

function load(): Loaded {
    if (_loaded) return _loaded;
    const issues: string[] = [];
    const p = dataFile(MODELS_DEV_DIY_FILE);
    if (!p) {
        return (_loaded = { windows: {}, issues: [`${MODELS_DEV_DIY_FILE} 缺失 → 引用时段表的档一律不命中（退 base 价）`] });
    }
    let windows: WindowTable = {};
    try {
        const parsed = ModelsDevDiyFileSchema.safeParse(JSON.parse(readFileSync(p, "utf-8")));
        if (!parsed.success) {
            return (_loaded = {
                windows: {},
                issues: [`${MODELS_DEV_DIY_FILE} 结构非法 → 忽略整份扩展层: ${parsed.error.message}`],
            });
        }
        windows = parsed.data.windows;
    } catch (e) {
        return (_loaded = {
            windows: {},
            issues: [`${MODELS_DEV_DIY_FILE} 解析失败 → 忽略整份扩展层: ${e instanceof Error ? e.message : String(e)}`],
        });
    }
    // 展开一遍（只为把坏段报出来）：坏段不影响其余段与其余表
    for (const [id, def] of Object.entries(windows)) issues.push(...resolveWindow(def, id).issues);
    if (issues.length > 0) console.warn(`时段表告警: ${issues.join(" | ")}`);
    return (_loaded = { windows, issues });
}

/** 时段表 id → 定义（表缺失/损坏 → `{}`） */
export function windowTable(): WindowTable {
    return load().windows;
}

/** 扩展层加载期的告警（缺失/非法/坏段） */
export function windowIssues(): string[] {
    return load().issues;
}

/** 时段表清单（RPC 下发用：id + 展示名 + 人读摘要；定义本身不下发） */
export function windowChoices(): WindowChoice[] {
    return Object.entries(load().windows).map(([id, def]) => ({
        id,
        label: def.label ?? id,
        detail: windowSummary(def),
    }));
}
