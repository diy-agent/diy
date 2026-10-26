// 🎯 JobWatch（##408 v2）的**判据层**：多久看一眼、看了算不算「变了」、变了说什么话。
//
// 一句话定位：**隔很久看一眼，变了才说话**。它不是调度器（不启动任何东西），不是
// 监控系统（不存历史、不告警、不推送），也不烧模型（探测是纯代码）。
//
// 为什么值得单独一层（来自 ##266 的实录）：原来一个 `dispatch-watch` 脚本每 30 分钟
// **无条件**唤醒 agent —— 三天 144 拍，其中 136 次什么都没变，≈720KB 白灌进上下文；
// 而真正该被发现的事（脚本自己死了）两天没人知道。判据拆成两条就都解决了：
//   ① **变了才说话**（`probeSucceeded` 的 verdict）—— 没变就只记一笔，不发消息；
//   ② **死掉要看得见**（`probeFailed` 的 errorStreak）—— 探针连续失败不是"安静"，
//      是这件事本身坏了，将来要变成 run 表里一条 failed 的 run。
//
// 零 IO：本文件不读盘、不取时间（`now` 由调用方传）、不起定时器。落盘与执行在
// `main/services/job-watch-registry.ts`；一拍从哪来在 `core-ticker.ts`。
//
// 存款项的取舍：
//   · **`every` 以分钟为单位、折成整数拍**（`TICK_MS = 60s`）—— 7 分钟这种值会把相位
//     拖成"有时 6 拍有时 8 拍"，故类型上就只允许一组合法值。
//   · **基线与变化分开**：第一次探测只建基线（`baseline`），**不喊人** —— 否则每个新
//     watch 都要先打扰一次。
//   · **降频只降不快**：`quietStreak` 越长间隔越久（×4 阶梯，封顶 6h），一有变化立刻
//     回到原频率。封顶是硬要求：6h 是"人还能当天发现坏了"的上限。

/** 间隔上限（分钟）：再怎么降频，一天至少看一眼。 */
export const WATCH_MAX_EVERY_MIN = 360;

/** 连续无变化时，间隔按 ×4 阶梯放大；第 n 阶 = `4^n`（封顶见上）。 */
export const WATCH_QUIET_LADDER = 4;

/** 合法间隔（分钟）。故意不是任意整数：见头注「折成整数拍」。 */
export const WATCH_EVERY_CHOICES = [1, 5, 15, 30, 60, 120, 180, 360] as const;
export type WatchEvery = (typeof WATCH_EVERY_CHOICES)[number];

/** `quietAfter` 的缺省拍数：连续 4 次没变化才开始降频（一天一拍的 watch 就是 4 天）。 */
export const DEFAULT_QUIET_AFTER = 4;

/** 一个探针采到的一段事实：`key` 是身份（稳定），`value` 是内容（可比）。 */
export interface ProbePart {
    readonly key: string;
    /** 值上限 200 字（见 `clampPart`）：落盘的是它，不是全量。 */
    readonly value: string;
}

/** watch 定义（用户/agent 写的那份，落盘在 `$DIY_HOME/jobs/watch/defs/<id>.json`）。 */
export interface JobWatchDef {
    readonly id: string;
    /** 一行标题：将来投递的第一行就是它 */
    readonly title: string;
    /** 每隔多少分钟看一次（没降频时的基频） */
    readonly every: WatchEvery;
    /** 探针说明符，如 `glob:gen/**`；至少一条 */
    readonly probes: readonly string[];
    /** 连续多少次无变化后开始降频；0 = 永不降频 */
    readonly quietAfter: number;
    readonly createdAt: string;
    readonly enabled: boolean;
}

/** watch 的运行状态（落盘在 `$DIY_HOME/jobs/watch/state/<id>.json`）。 */
export interface JobWatchState {
    /** 上次探测的指纹；null = 还没探过 */
    readonly fingerprint: string | null;
    /** 上次探测的原始 parts（算 diff 用；只留截断后的值） */
    readonly lastParts: readonly ProbePart[] | null;
    readonly lastProbeAt: number | null;
    readonly lastChangeAt: number | null;
    /** 连续无变化的次数（降频依据） */
    readonly quietStreak: number;
    /** 总探测次数（可观测） */
    readonly probes: number;
    /** 连续失败次数（>0 ⇒ 这个 watch 现在探不动了） */
    readonly errorStreak: number;
    readonly lastError: string | null;
}

export const EMPTY_WATCH_STATE: JobWatchState = {
    fingerprint: null,
    lastParts: null,
    lastProbeAt: null,
    lastChangeAt: null,
    quietStreak: 0,
    probes: 0,
    errorStreak: 0,
    lastError: null,
};

/** 一次探测的结论。`baseline` 与 `no-change` 都**不该**喊人。 */
export type ProbeVerdict = "baseline" | "no-change" | "changed";

export interface ProbeOutcome {
    readonly state: JobWatchState;
    readonly verdict: ProbeVerdict;
    /** 只有 `changed` 时非空：要说给人听的那几行 */
    readonly diff: string;
}

/** 落盘前统一截断：指纹与 diff 只需要"够认出来"，不需要全文。 */
export const PART_VALUE_MAX = 200;
/** 投递正文上限（≈ 380B 的实测口径留了余量，但别让一次 diff 灌满上下文）。 */
export const WATCH_DIFF_MAX = 2000;

function clampText(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function clampPart(part: ProbePart): ProbePart {
    return { key: part.key, value: clampText(part.value, PART_VALUE_MAX) };
}

/**
 * 当前生效的间隔（分钟）。
 *
 * 阶梯：基础间隔 × `4^floor(quietStreak / quietAfter)`，封顶 360 分钟。
 * `quietAfter <= 0` = 不降频（勤快的人自己管）。
 */
export function intervalMinOf(def: JobWatchDef, state: JobWatchState): number {
    const base = def.every;
    if (def.quietAfter <= 0) return base;
    const steps = Math.floor(state.quietStreak / def.quietAfter);
    if (steps <= 0) return base;
    // 闸在 8 阶（4^8 = 65536）：任何 base 都在封顶前先撞到 `WATCH_MAX_EVERY_MIN`，
    // 这个上限只是防止 `4 ** 大数` 溢出成 Infinity（Infinity 与封顶 min 完也是 360，
    // 但别让「算出了个荒唐中间值」这种事存在）。
    const factor = WATCH_QUIET_LADDER ** Math.min(steps, 8);
    return Math.min(base * factor, WATCH_MAX_EVERY_MIN);
}

/** 这一拍该不该探。从未探过 ⇒ 立刻探（新 watch 不必等一个周期）。 */
export function isDue(def: JobWatchDef, state: JobWatchState, now: number): boolean {
    if (!def.enabled) return false;
    if (state.lastProbeAt === null) return true;
    return now - state.lastProbeAt >= intervalMinOf(def, state) * 60_000;
}

/** 下次该探的时刻；不 enabled / 从未探过 ⇒ null（后者是「现在就该探」）。 */
export function nextDueAt(def: JobWatchDef, state: JobWatchState): number | null {
    if (!def.enabled || state.lastProbeAt === null) return null;
    return state.lastProbeAt + intervalMinOf(def, state) * 60_000;
}

/**
 * 指纹：64 位 FNV-1a（两路 32 位拼接）。
 *
 * 为什么不用 sha256：这里是**变化检测**不是安全摘要，碰撞的代价是「漏报一次变化」，
 * 下一拍内容仍不同就会再报——可自愈。用纯 JS 换掉一次 `node:crypto` 的初始化。
 */
export function fingerprintOf(parts: readonly ProbePart[]): string {
    const canon = canonicalParts(parts);
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < canon.length; i++) {
        const c = canon.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 + c, 0x85ebca6b);
    }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** 规范化：按 key 排序 + `key=value` 拼行 —— 顺序变了不算变化。 */
function canonicalParts(parts: readonly ProbePart[]): string {
    return parts
        .map((p) => clampPart(p))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((p) => `${p.key}=${p.value}`)
        .join("\n");
}

/**
 * 人话 diff：只列变化的那几行。
 *
 *   `+ key = value`  新出现的探针
 *   `- key`          消失的探针
 *   `~ key: 旧 → 新` 值变了
 *
 * 没有任何变化 ⇒ 空串（调用方据此判定"不喊人"）。
 */
export function diffParts(prev: readonly ProbePart[] | null, next: readonly ProbePart[]): string {
    if (prev === null) return "";
    const before = new Map(prev.map((p) => [p.key, clampPart(p).value]));
    const after = new Map(next.map((p) => [p.key, clampPart(p).value]));
    const lines: string[] = [];
    for (const [key, value] of after) {
        if (!before.has(key)) lines.push(`+ ${key} = ${value}`);
        else if (before.get(key) !== value) lines.push(`~ ${key}: ${before.get(key)} → ${value}`);
    }
    for (const key of before.keys()) {
        if (!after.has(key)) lines.push(`- ${key}`);
    }
    return clampText(lines.join("\n"), WATCH_DIFF_MAX);
}

/**
 * 一次**成功**探测之后的状态推进。
 *
 * 三种结局：
 *   · 第一次（没有旧指纹）⇒ `baseline`：只建基线，**不喊人**；
 *   · 指纹没变 ⇒ `no-change`：`quietStreak + 1`（降频依据），不发消息；
 *   · 变了 ⇒ `changed`：清空 `quietStreak`（回到原频率），diff 交给调用方投递。
 */
export function probeSucceeded(
    def: JobWatchDef,
    state: JobWatchState,
    parts: readonly ProbePart[],
    now: number,
): ProbeOutcome {
    void def; // 参数位保留：将来 diff 头可能要带 title（签名先对称，免得到处改调用）
    const clamped = parts.map(clampPart);
    const fingerprint = fingerprintOf(clamped);
    const base: JobWatchState = {
        ...state,
        fingerprint,
        lastParts: clamped,
        lastProbeAt: now,
        probes: state.probes + 1,
        errorStreak: 0,
        lastError: null,
    };

    if (state.fingerprint === null) {
        return { state: { ...base, quietStreak: 0 }, verdict: "baseline", diff: "" };
    }
    if (state.fingerprint === fingerprint) {
        return { state: { ...base, quietStreak: state.quietStreak + 1 }, verdict: "no-change", diff: "" };
    }
    return {
        state: { ...base, quietStreak: 0, lastChangeAt: now },
        verdict: "changed",
        diff: diffParts(state.lastParts, clamped),
    };
}

/**
 * 一次**失败**探测：不推进指纹（内容未知 ≠ 没变化），但错误要累积。
 *
 * `errorStreak` 的用途（不在本层判）：连续 ≥3 次 ⇒ 上层把这个 watch 标成 `failed`，
 * 在 run 表里亮红灯 —— 「watch 死了」必须比「没有变化」更吵。
 */
export function probeFailed(state: JobWatchState, message: string, now: number): JobWatchState {
    return {
        ...state,
        lastProbeAt: now,
        probes: state.probes + 1,
        errorStreak: state.errorStreak + 1,
        lastError: clampText(message, PART_VALUE_MAX),
    };
}

/** 连续失败几次算「这个 watch 坏了」（上层据此标记 failed）。 */
export const WATCH_ERROR_STREAK_LIMIT = 3;

export function isBroken(state: JobWatchState): boolean {
    return state.errorStreak >= WATCH_ERROR_STREAK_LIMIT;
}

// ─── 定义校验（写入口：`diy job watch add`）────────────────

/**
 * id 合法性。**这里是路径穿越的唯一闸门**（落盘名 `<id>.json`）。
 *
 * 只允许小写字母 / 数字 / 连字符，且必须以字母开头、≤ 64 字：
 * `../`、`.`、`/`、空串、大写一律拒绝 —— 大写在小写文件系统上会撞名。
 */
export function watchIdError(id: string): string | null {
    if (!id) return "id 不能为空";
    if (id.length > 64) return "id 太长（≤ 64）";
    if (!/^[a-z][a-z0-9-]*$/.test(id)) return "id 只允许小写字母 / 数字 / 连字符，且以字母开头";
    return null;
}

/** 定义校验：返回第一条错误，全合法 ⇒ null。 */
export function validateWatchDef(def: JobWatchDef): string | null {
    const idErr = watchIdError(def.id);
    if (idErr) return idErr;
    // 手改过的 JSON 会缺字段：每一条都先判类型，别让 `.trim()` / `.length` 崩在坏数据上
    // （loadDefs 的容错契约是「坏定义跳过」，不是「抛给调用方」）。
    if (typeof def.title !== "string" || !def.title.trim()) return "title 不能为空";
    if (def.title.length > 80) return "title 太长（≤ 80）";
    if (typeof def.every !== "number" || !WATCH_EVERY_CHOICES.includes(def.every)) {
        return `every 只允许 ${WATCH_EVERY_CHOICES.join(" / ")} 分钟`;
    }
    if (!Array.isArray(def.probes) || def.probes.length === 0) return "至少一条探针";
    if (def.probes.length > 10) return "探针最多 10 条";
    for (const spec of def.probes) if (typeof spec !== "string" || !spec.trim()) return "探针不能是空串";
    if (!Number.isInteger(def.quietAfter) || def.quietAfter < 0) return "quietAfter 必须是非负整数";
    if (def.quietAfter > 100) return "quietAfter 太大（≤ 100）";
    return null;
}

/**
 * JobWatch 的**预期内**错误（用户写错定义 / 探针说明符不认识 / 运行环境不支持）。
 *
 * 与 `InvariantError` 的分工：那个是「我方缺陷」，这个不是 —— 用户传了 `glob:` 以外的
 * 说明符、或手改了 `defs/*.json`，都是世界给的输入，`triageOf` 应判 `external-*`。
 * 首参是 code（`scripts/check-error-code.mjs` 的白名单口径），调用处必须写字面量。
 */
export class JobWatchError extends Error {
    readonly code: string;
    constructor(code: string, detail: string) {
        super(detail);
        this.name = "JobWatchError";
        this.code = code;
    }
}
