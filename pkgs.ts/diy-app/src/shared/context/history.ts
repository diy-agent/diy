// src/shared/context/history.ts
// 🎯 上下文「变更」历史（纯函数）：把每次重算的结果攒成 step 列表。
//
// 为什么需要它：请求体太复杂，看不出"提示词这一层每一步到底发生了什么"。
// 这里只保留**两个容器的文本**与**值 hash 表**，因此可以回答：
//   · 这一步变了哪些变量（值 hash 对比）
//   · 这些变化落在 system 份还是 runtime 份（投递动作不同：全量重建 vs 增量 patch）
//   · 具体变化内容（两份文本的行级 diff）
//
// 两个容器在这里的差异一眼可见 —— 这正是它比"合并在请求体里看"强的地方：
//   system 是**全量重建**，所以从 wire 看永远整份都在，对人有用的是"哪个变量导致的"
//   runtime 是**增量 patch**，直接看 ops 即可
//
// 数据来源是**真实**的：页面每次重算都调 record()，内容没变就不会新增 step
// （144 的"内容未变不发"落到 UI 上就是"没变的 step 不出现在列表里"）。

import { lineDiff, type DiffLine } from "../line-diff";

/** 一次投递的快照（记 step 用） */
export interface StepSnapshot {
    /** 值 hash 表（path → hash；用于判断变了哪些变量） */
    valueHashes: Record<string, string>;
    /** system 份文本（含它包含哪些单元） */
    systemText: string;
    systemPlaces: string[];
    /** runtime 份文本 */
    runtimeText: string;
    runtimePlaces: string[];
}

/** 一个变化步骤（只在**确实有变化**时产生） */
export interface ContextStep {
    /** 序号（1 基，只数有变化的） */
    index: number;
    /** 记录时刻（ISO） */
    at: string;
    /** 变化的变量路径（值 hash 不同者，字典序） */
    changed: string[];
    /** 变化里落在 system 份的（前缀匹配 systemPlaces） */
    systemTouched: string[];
    /** 变化里落在 runtime 份的 */
    runtimeTouched: string[];
    /** system 份是否整体变化（渲染结果变了才算，含"变化是别的容器引起的"这一情况） */
    systemDiffers: boolean;
    runtimeDiffers: boolean;
    /** 与上一步的两份文本 diff（点开看内容用） */
    systemDiff: DiffLine[];
    runtimeDiff: DiffLine[];
    /** 该步之后的两份完整文本（选中该步时预览用） */
    snapshot: StepSnapshot;
}

export interface ContextHistory {
    /** 基线（第一个快照；不算"变化"） */
    baseline: StepSnapshot | null;
    steps: ContextStep[];
}

export function emptyHistory(): ContextHistory {
    return { baseline: null, steps: [] };
}

/** 某 path 是否落在这些单元里（自身或其后代） */
function underAny(path: string, places: readonly string[]): boolean {
    return places.some((p) => path === p || path.startsWith(`${p}.`));
}

/**
 * 记录一次重算结果。
 * 返回**新的** history（纯函数）；内容与上一次完全一致时不新增 step。
 */
export function record(history: ContextHistory, next: StepSnapshot, at: string): ContextHistory {
    if (!history.baseline) return { baseline: next, steps: [] };
    const prev = history.steps.length > 0 ? history.steps[history.steps.length - 1]!.snapshot : history.baseline;

    const keys = new Set([...Object.keys(prev.valueHashes), ...Object.keys(next.valueHashes)]);
    const changed = [...keys].filter((k) => prev.valueHashes[k] !== next.valueHashes[k]).sort();

    const systemDiffers = prev.systemText !== next.systemText;
    const runtimeDiffers = prev.runtimeText !== next.runtimeText;
    // 值没变也可能是投递范围变了（用户改了 system 名单）→ 仍算一次变化
    if (changed.length === 0 && !systemDiffers && !runtimeDiffers) return history;

    const step: ContextStep = {
        index: history.steps.length + 1,
        at,
        changed,
        systemTouched: changed.filter((p) => underAny(p, next.systemPlaces)),
        runtimeTouched: changed.filter((p) => underAny(p, next.runtimePlaces)),
        systemDiffers,
        runtimeDiffers,
        systemDiff: systemDiffers ? lineDiff(prev.systemText, next.systemText) : [],
        runtimeDiff: runtimeDiffers ? lineDiff(prev.runtimeText, next.runtimeText) : [],
        snapshot: next,
    };
    return { baseline: history.baseline, steps: [...history.steps, step] };
}

/** diff 的增删统计（列表里一眼看变化量） */
export function diffStat(diff: readonly DiffLine[]): { add: number; del: number } {
    let add = 0;
    let del = 0;
    for (const d of diff) {
        if (d.t === "+") add++;
        else if (d.t === "-") del++;
    }
    return { add, del };
}
