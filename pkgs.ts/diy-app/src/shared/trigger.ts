/**
 * 触发器的**定义形状**（纯类型 + 纯函数，零 IO、零取时间）。
 *
 * 为什么要有这一层（##408 v2 · 2026-10-26 大王定）：
 *
 * 今天「系统会叫你什么」全散在代码里 —— 每处都长成 `if (出事了) { 通知 }`，而
 * 「通知」那一步各自挑 inbox / wakeTaskWithSteer / journal / toast 中的某一个。
 * 三个后果：说不清系统一共会打扰你几种事（`diy trigger ls` 之前根本不存在）、
 * 想把某条降成静默要改代码发版、同一个故障可能从三条路推三次。
 *
 * 统一形态：**没有内置事件，全部从零注册**。每条触发器 = 一次 `defineTrigger()`，
 * 返回一个**带类型的句柄**；调用点只用句柄（`runSettled.emit({ runId, … })`）。
 * 于是 id 拼错在类型层面不可能、payload 字段错编译期就红 —— 字符串 id 只存在于
 * 定义处一次。
 *
 * 三条判据（大王 2026-10-26）：
 *   · **不与持久化绑定**：注册表是内存 Map，插件卸载即消失。要落盘的只有 watch 的
 *     指纹基线（pull 源跨时间对比的唯一资产），与触发器定义本身无关。
 *   · **表是产品定义，不是用户偏好**：改它要发版。用户能改的是 level 覆盖（另说）。
 *   · **可扩展**：插件在 activate 时注册，id 必带命名空间（`<plugin>:<id>`），
 *     内置的也带（`job:` / `watch:` / `env:` …）—— 一条规则，不分内外。
 */

/** 打扰强度（facts `level#notice` 那把尺子，0 最高）。`N3` = 只进 journal，agent 不许投。 */
export type Level = "N0" | "N1" | "N2" | "N3";

/** 由弱到强排列（打印目录时倒序给「最急的在上」）。 */
export const LEVELS: readonly Level[] = ["N3", "N2", "N1", "N0"];

/** 一句人话，给 `diy trigger ls` 与 UI 用；不在任何判据里参与计算。 */
export const LEVEL_TEXT: Readonly<Record<Level, string>> = {
    N0: "强干预",
    N1: "叫醒",
    N2: "未读",
    N3: "只记",
};

export const LEVEL_DESC: Readonly<Record<Level, string>> = {
    N0: "toast + 拉回窗口 / 抢焦点（真出事才用）",
    N1: "进会话开一轮 + 信箱留痕",
    N2: "信箱 +1，不打扰",
    N3: "只进 journal，人不用管（agent 不许投 N3）",
};

/** 一条触发器的声明。`P` 是 payload 形状 —— 句柄的 `emit()` 靠它做编译期校验。 */
export interface TriggerDef<P> {
    /**
     * 全局唯一 id，**必须带命名空间**：`<ns>:<name>`。
     *
     * 内置用 `job:` / `watch:` / `env:` / `notice:` / `inbox:`；插件用插件自己的名字。
     * 为什么要冒号：插件便无法冒充内置（不做优先级仲裁，靠命名空间天然隔离）。
     */
    readonly id: string;
    /** 一句话说清「什么时候会叫你」—— 进 `diy trigger ls`，也进 UI 目录。 */
    readonly desc: string;
    /** 打扰强度。push 源的事件自带全部信息，level 由这里定，调用方不许覆盖。 */
    readonly level: Level;
    /**
     * 投给谁。**变量，不是地址** —— 运行时才解析：
     *   `"owner"`  → 事件载荷里的 taskUri（`run-settled` 用）
     *   `"def"`    → 触发器自带的地址（watch 定义里的 sinks）
     *   `"inbox"`  → 信箱
     *   `"ui"`     → 顶栏 / 横幅这类"只在界面上"的呈现
     *   `task:<uri>` / `global` → 显式地址
     */
    readonly sinks: readonly string[];
}

/** `defineTrigger()` 的返回：注册过的句柄。拿到它 = 已注册（结构上不可能漏注册）。 */
export interface Trigger<P> {
    readonly id: string;
    readonly level: Level;
    readonly sinks: readonly string[];
    /** 唯一的出口。不改返回值、不抛业务错（观测数据可以腐烂，但不许拖死调用方）。 */
    emit(payload: P): void;
}

/** id 不合法时的机器码（与 `invariant` 的码同一套风格）。 */
export const TRIGGER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;

/**
 * id 是否合法：`<ns>:<name>`，小写字母数字加连字符，点与下划线只许出现在 name 段。
 *
 * 纯函数、不抛 —— 调用方（注册表）自己决定抛什么。
 */
export function isValidTriggerId(id: string): boolean {
    return TRIGGER_ID_PATTERN.test(id);
}

/** 命名空间（冒号前那半）；非法 id 返回 `null`（不抛，便于列表里过滤脏数据）。 */
export function triggerNamespace(id: string): string | null {
    if (!isValidTriggerId(id)) return null;
    return id.slice(0, id.indexOf(":"));
}
