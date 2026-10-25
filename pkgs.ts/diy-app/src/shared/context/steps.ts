// src/shared/context/steps.ts
// 🎯 「每轮真发」的投递快照（Step）与其 diff —— 纯函数 + 类型，落盘形状与传输形状同一份。
//
// 为什么需要它：投递太复杂，看不出"提示词这一层每一步到底发生了什么"。有了每轮快照，
// 两种变更都能回答（144 的设计原话：system 全量重建、runtime 增量 patch）：
//   · 选中第 N 步 → 第 N 步 vs 第 N-1 步
//   · 取消选中   → 当前变量树 vs 最后一步
//
// 为什么不用"页面轮询重算"：那种观察列表没有因果、关页面就丢、不对齐真实轮次，
// 且实现（`history.ts`）已随本方案删除（`d9917c9`）；本文件是**真发落盘**的事实记录（对齐轮次、可回放）。
//
// 落盘：会话目录 `$DIY_HOME/local/<uri 路径>/<key>/steps.jsonl`（##379 分层；旧平铺 `<key>.steps.jsonl` 读侧兜底），一行一条（append-only）。
// **不塞进 raw.jsonl**：那是旁路观测（明确不参与 UI/状态恢复），而这份是投递事实。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import { lineDiff, type DiffLine } from "../line-diff";

/** 一条投递快照（落盘形状；index 由读取顺序给出，不落盘） */
export interface DeliveryStepRecord {
    /** 记录时刻（ISO） */
    ts: string;
    /** 轮次 id（与 ops/审计同一套 turnId，便于交叉检索） */
    turnId: string;
    model: string;
    /** 投递编码版本（变了就说明"同形不可比"，diff 要标注） */
    wireVersion: string;
    systemPlaces: string[];
    runtimePlaces: string[];
    /** path → 子树值 hash（"哪些变量变了"） */
    valueHashes: Record<string, string>;
    /** system 容器全文（含说明头）—— 每轮全量，故 diff 需要两份全文 */
    systemText: string;
    /** runtime 容器全文 */
    runtimeText: string;
    /**
     * 尾部信封里 `history:` 那一段（压缩索引注记；空/缺 = 本轮没压缩 / 老快照没记）。
     *
     * 为什么要记（##5 第 16 轮，用户实测：「runtimeDiff 里并没有体现出 history 的变化」）：
     * `history:` **不是变量树的单元** —— 它是 `deliveryHistory()` 在轮首算出来、由 `withRuntime`
     * 拼进信封的一段，真源是压缩选择（`selectHistoryByBudget`），与 `assembleGlobals` 无关。
     * 于是它既不会出现在 `runtimeDiff` 里，也不进 `valueHashes` ⇒ **变化了也没有任何地方能看到**。
     * 记进快照后，步骤列表/差异视图才能回答「这一轮 history 段跟上一轮一样吗」。
     */
    historyText?: string;
    /** 尾部信封里 `summary:` 那一段（历史摘要；空/缺 = 没启用摘要 / 老快照没记） */
    summaryText?: string;
}

/** 快照 + 序号（读取时按行序赋；1 基） */
export interface DeliveryStep extends DeliveryStepRecord {
    index: number;
}

/** 相邻两步的差异 */
export interface StepDiff {
    /** 值 hash 不同的 path（含中间容器；字典序，稳定可比对） */
    changed: string[];
    /** system 份是否整体变化（渲染结果变了才算） */
    systemDiffers: boolean;
    runtimeDiffers: boolean;
    /** 行级 diff（点开看内容用）；未变则空数组 */
    systemDiff: DiffLine[];
    runtimeDiff: DiffLine[];
    /** `history:` 注记段是否变（老快照缺字段 ⇒ false = 不下结论，不谎报"变了"） */
    historyDiffers: boolean;
    summaryDiffers: boolean;
    historyDiff: DiffLine[];
    summaryDiff: DiffLine[];
}

/**
 * 比较两步。
 * 注意 wireVersion 不同 → 不是"内容变了"而是**不可比**（`incomparable` 标 true），
 * UI 应显示"编码版本变化，重新建立了 baseline"，而不是拿两份不同编码的文本做 diff。
 */
export function diffSteps(prev: DeliveryStepRecord, next: DeliveryStepRecord): StepDiff & { incomparable: boolean } {
    const keys = new Set([...Object.keys(prev.valueHashes), ...Object.keys(next.valueHashes)]);
    const changed = [...keys].filter((k) => prev.valueHashes[k] !== next.valueHashes[k]).sort();
    const systemDiffers = prev.systemText !== next.systemText;
    const runtimeDiffers = prev.runtimeText !== next.runtimeText;
    // 注记段：**缺字段**（老快照）与「空串」是两码事 —— 老快照永远 `undefined`，
    // 拿它跟新快照的 `history:\n…` 比会报一次假「变了」（同一形状的坑：`expose` 曾把
    // "合并后集合非空"当成"这个库声明了"，于是默认档静默失效）。缺 = 不知道 ⇒ 不下结论。
    const cmpNote = (a: string | undefined, b: string | undefined): [boolean, DiffLine[]] => {
        if (a === undefined || b === undefined) return [false, []];
        if (a === b) return [false, []];
        return [true, lineDiff(a, b)];
    };
    const [historyDiffers, historyDiff] = cmpNote(prev.historyText, next.historyText);
    const [summaryDiffers, summaryDiff] = cmpNote(prev.summaryText, next.summaryText);
    return {
        changed,
        systemDiffers,
        runtimeDiffers,
        historyDiffers,
        summaryDiffers,
        systemDiff: systemDiffers ? lineDiff(prev.systemText, next.systemText) : [],
        runtimeDiff: runtimeDiffers ? lineDiff(prev.runtimeText, next.runtimeText) : [],
        historyDiff,
        summaryDiff,
        incomparable: prev.wireVersion !== next.wireVersion,
    };
}

/** diff 的增删统计（列表里一眼看变化量） */
export function diffSize(diff: readonly DiffLine[]): { add: number; del: number } {
    let add = 0;
    let del = 0;
    for (const d of diff) {
        if (d.t === "+") add++;
        else if (d.t === "-") del++;
    }
    return { add, del };
}

/** 读取到的行序 → 带序号的快照列表 */
export function withIndex(records: readonly DeliveryStepRecord[]): DeliveryStep[] {
    return records.map((r, i) => ({ ...r, index: i + 1 }));
}

/** 一步的摘要（列表用；不带全文 —— 每份 system 几十 KB，列表下发不可行） */
export interface StepSummary {
    index: number;
    ts: string;
    turnId: string;
    model: string;
    wireVersion: string;
    /** 两个容器的字节数（列表里一眼看体量） */
    bytes: { system: number; runtime: number };
    systemPlaces: string[];
    runtimePlaces: string[];
    /**
     * 与**上一步**的比较；首步为 null（它是 baseline，没有"上一步"）。
     * 只放**统计**+ 判定，不放行内容 —— 列表一条都别带几十 KB 的 diff
     * （行内容在 `diff` 字段，只有 `withDiff` 时才带；详情走 `context diff`）。
     */
    sincePrev: {
        changed: string[];
        systemDiffers: boolean;
        runtimeDiffers: boolean;
        /** `history:` 注记段是否变（老快照缺字段时为 false = 不下结论） */
        historyDiffers: boolean;
        summaryDiffers: boolean;
        incomparable: boolean;
        systemSize: { add: number; del: number };
        runtimeSize: { add: number; del: number };
        historySize: { add: number; del: number };
    } | null;
    /** 行级 diff 内容（`withDiff` 时才带；默认只给统计，避免下发整份文本） */
    diff?: { system: DiffLine[]; runtime: DiffLine[]; history: DiffLine[] } | null;
}

/**
 * 摘要列表（尾部 limit 条，按时间正序返回 —— 列表要 newest-first 由 UI 自己 reverse）。
 * **只算摘要不算全文**：diff 在 main 侧算完，下发的是统计（和可选的行内容）。
 */
export function summarizeSteps(
    records: readonly DeliveryStepRecord[],
    opts: { limit?: number; withDiff?: boolean } = {},
): StepSummary[] {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : records.length;
    const kept = records.slice(Math.max(0, records.length - limit));
    const base = records.length - kept.length; // 被裁掉的前缀长度 → index 仍然对齐真实轮次
    const byteLen = (t: string): number => new TextEncoder().encode(t).length;
    return kept.map((r, i) => {
        const idx = base + i;
        const prev = idx > 0 ? records[idx - 1]! : null;
        const d = prev ? diffSteps(prev, r) : null;
        const raw = opts.withDiff && d ? { system: d.systemDiff, runtime: d.runtimeDiff, history: d.historyDiff } : undefined;
        return {
            index: idx + 1,
            ts: r.ts,
            turnId: r.turnId,
            model: r.model,
            wireVersion: r.wireVersion,
            bytes: { system: byteLen(r.systemText), runtime: byteLen(r.runtimeText) },
            systemPlaces: r.systemPlaces,
            runtimePlaces: r.runtimePlaces,
            sincePrev: d
                ? {
                      changed: d.changed,
                      systemDiffers: d.systemDiffers,
                      runtimeDiffers: d.runtimeDiffers,
                      historyDiffers: d.historyDiffers,
                      summaryDiffers: d.summaryDiffers,
                      incomparable: d.incomparable,
                      systemSize: diffSize(d.systemDiff),
                      runtimeSize: diffSize(d.runtimeDiff),
                      historySize: diffSize(d.historyDiff),
                  }
                : null,
            ...(opts.withDiff ? { diff: raw ?? null } : {}),
        };
    });
}
