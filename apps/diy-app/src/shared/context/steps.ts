// src/shared/context/steps.ts
// 🎯 「每轮真发」的投递快照（Step）与其 diff —— 纯函数 + 类型，落盘形状与传输形状同一份。
//
// 为什么需要它：投递太复杂，看不出"提示词这一层每一步到底发生了什么"。有了每轮快照，
// 两种变更都能回答：
//   · 选中第 N 步 → 第 N 步 vs 第 N-1 步
//   · 取消选中   → 当前变量树 vs 最后一步
//
// 为什么不用"页面轮询重算"：那种观察列表没有因果、关页面就丢、不对齐真实轮次。
// 本文件是**真发落盘**的事实记录（对齐轮次、可回放）。
//
// 落盘：会话目录 `$DIY_HOME/local/<uri 路径>/<key>/steps.jsonl`（##379 分层；旧平铺 `<key>.steps.jsonl` 读侧兜底），一行一条（append-only）。
// **不塞进 raw.jsonl**：那是旁路观测（明确不参与 UI/状态恢复），而这份是投递事实。
//
// ##520：没有 system / runtime 两容器了 —— 快照只记**一份** system 文本（信封 `help:` + `vars:`）。
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
    /** 原子单元名单（增量与变更历史的粒度；##520 起没有 system/runtime 划分） */
    places: string[];
    /** path → 子树值 hash（"哪些变量变了"） */
    valueHashes: Record<string, string>;
    /** 真发的 system 参数全文（`help:` + `vars:` 信封）—— 每轮全量，故 diff 需要两份全文 */
    systemText: string;
    /**
     * 该步 system 快照所属的压缩段（生效边界的 `at`；缺省 = 从未压缩 / 旧快照）。
     * 边界变了 ⇒ 新段必须用现状重建 system（`frozenSystemTextOf` 的判据）。
     */
    compactAt?: string;
    /**
     * **老快照遗留**：##520 之前的 `runtime:` 段副本。新记录不再写，读侧容忍缺字段。
     * 保留它只为读存量步骤记录（不再参与新快照的 diff 结论）。
     */
    runtimeText?: string;
    /**
     * 尾部信封里 `history:` 那一段（压缩索引注记；空/缺 = 本轮没压缩 / 老快照没记）。
     *
     * 为什么要记（##5 第 16 轮，用户实测：「runtimeDiff 里并没有体现出 history 的变化」）：
     * `history:` **不是变量树的单元** —— 它是 `deliveryHistory()` 在轮首算出来、由 `withRuntime`
     * 拼进信封的一段，真源是压缩选择（`selectHistoryByBudget`），与 `assembleGlobals` 无关。
     * 于是它既不会出现在增量里，也不进 `valueHashes` ⇒ **变化了也没有任何地方能看到**。
     * 记进快照后，步骤列表/差异视图才能回答「这一轮 history 段跟上一轮一样吗」。
     */
    historyText?: string;
    /** 尾部信封里 `summary:` 那一段（历史摘要；空/缺 = 没启用摘要 / 老快照没记） */
    summaryText?: string;
    /**
     * 真发 tools 定义的 hash（`sha256Hex(JSON.stringify(tools))`；老快照缺字段 = 没记）。
     *
     * 为什么要记（##519）：tools 在 wire 上排在 system **之前**，改一个字节（哪怕只是描述里的
     * 一个空格）就把整段前缀缓存作废 —— 而 `toolsBytes` 撞巧相等时（实测：改前后都是 952 B）
     * 从字节数根本看不出来，只能翻 reqlog 逐字节 diff。
     * 与上一条不同 ⇒ 这一步的整段失配是**我们自己改的**，不是网关的问题。
     */
    toolsHash?: string;
    /**
     * 真发时的网关会话 id（`sessionIdOf(taskUri)`；拿不到 / 非网关端点则缺）。
     *
     * 记它是为了把「整段 cacheRead=0」拆成两种：(a) 会话换了；(b) 会话没换、缓存就是没了。
     * 后者是网关侧（分片 / 逐出 / 落到别的上游节点），我们不可控 —— 不记这一位就只能靠猜（##519）。
     */
    sessionId?: string;
}

/** 快照 + 序号（读取时按行序赋；1 基） */
export interface DeliveryStep extends DeliveryStepRecord {
    index: number;
}

/** 相邻两步的差异 */
export interface StepDiff {
    /** 值 hash 不同的 path（含中间容器；字典序，稳定可比对） */
    changed: string[];
    /** 信封全文是否整体变化（渲染结果变了才算） */
    systemDiffers: boolean;
    /** 行级 diff（点开看内容用）；未变则空数组 */
    systemDiff: DiffLine[];
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
        historyDiffers,
        summaryDiffers,
        systemDiff: systemDiffers ? lineDiff(prev.systemText, next.systemText) : [],
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
    /** 信封全文的字节数（列表里一眼看体量） */
    bytes: { system: number };
    places: string[];
    /**
     * 与**上一步**的比较；首步为 null（它是 baseline，没有"上一步"）。
     * 只放**统计**+ 判定，不放行内容 —— 列表一条都别带几十 KB 的 diff
     * （行内容在 `diff` 字段，只有 `withDiff` 时才带；详情走 `context diff`）。
     */
    sincePrev: {
        changed: string[];
        systemDiffers: boolean;
        /** `history:` 注记段是否变（老快照缺字段时为 false = 不下结论） */
        historyDiffers: boolean;
        summaryDiffers: boolean;
        incomparable: boolean;
        systemSize: { add: number; del: number };
        historySize: { add: number; del: number };
    } | null;
    /** 行级 diff 内容（`withDiff` 时才带；默认只给统计，避免下发整份文本） */
    diff?: { system: DiffLine[]; history: DiffLine[] } | null;
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
        const raw = opts.withDiff && d ? { system: d.systemDiff, history: d.historyDiff } : undefined;
        return {
            index: idx + 1,
            ts: r.ts,
            turnId: r.turnId,
            model: r.model,
            wireVersion: r.wireVersion,
            bytes: { system: byteLen(r.systemText) },
            places: r.places ?? [],
            sincePrev: d
                ? {
                      changed: d.changed,
                      systemDiffers: d.systemDiffers,
                      historyDiffers: d.historyDiffers,
                      summaryDiffers: d.summaryDiffers,
                      incomparable: d.incomparable,
                      systemSize: diffSize(d.systemDiff),
                      historySize: diffSize(d.historyDiff),
                  }
                : null,
            ...(opts.withDiff ? { diff: raw ?? null } : {}),
        };
    });
}
