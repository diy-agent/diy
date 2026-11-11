// src/shared/output-budget.ts
// 🎯 「我们愿意付多少输出」与「模型物理上能给多少」的**分离**（##429）。
//
// 病灶（实测）：请求里的 `max_tokens` 直接等于 models.dev 的 `limit.output`
// （生产最贵一条 `projects/4/tasks/377`：output=131072=2^17，正好撞死在硬上限）。
// 于是「模型的物理上限」被当成了「我们的预算上限」—— 中间没有第二道闸。
//
// pi 的做法是把两者分开（模型配置的 `maxOutputTokens` 默认 16384，另有 provider 级覆盖）；
// 本模块抄这条**判据**，不抄代码：真发值 = `min(软上限, 模型硬上限)`。
//
// 为什么放在 shared（纯函数、无 node 依赖）：
//   · 判据要能被单测直接钉住（`tests/core/output-budget.test.ts`）；
//   · 调用侧有 main（真发）、预览（simulateRequest）与 CLI（limits 回显）三处，
//     三处必须同一套口径，否则"预览=真发"这条不变量当场破。
//
// 约定：本文件只放 schema/类型/纯函数，禁止 import node:*。

/**
 * 场景 = 「这次请求是干什么用的」。
 *
 * 三档不是拍脑袋：对话是主战场（给足，对齐 pi 的 16384），摘要要的是短 JSON（2000 早就够，
 * 现状保留），标题之类的小任务只要一两行（200）。按场景给缺省的理由与 `maxSteps` 同源：
 * **不同用途的合理预算本来就不同**，一个数管全部只会两头都不对。
 */
export const OUTPUT_SCENES = ["chat", "summary", "small"] as const;
export type OutputScene = (typeof OUTPUT_SCENES)[number];

/** 场景缺省软上限（tokens）。只在**没有更具体的覆盖**时生效（见 `resolveOutputBudget`） */
export const OUTPUT_SCENE_DEFAULTS: Record<OutputScene, number> = {
    // ##522（2026-11-11 用户拍）：16384 → 65536。16384 是 `pi` 的对话缺省，但那时
    // 没有把「思考 token 也计入 output」（reasoning 模型先吃一截，正文拿不到 16k），
    // 症状就是写个大文件就撞上限。65536 只是**允许**多写，不产生额外费用（按真吐的算）。
    chat: 65536,
    // 摘要（compaction）是 fail-closed：撞上限 = checkpoint 不完整、整次压缩作废。
    // 2000 太容易白跑，提到 8000（与 opencode 的 SUMMARY_OUTPUT_MAX=32k 同属"够用"档）。
    summary: 8000,
    small: 200,
};

/**
 * 输出**在窗口里还剩多少额度**（##522）—— 第三个 min 项，跟"我们愿付多少"无关。
 *
 * 为什么必须有这一项：`max_tokens` 太大时，上游会因为「输入 + 输出 > 上下文窗口」直接拒；
 * 而窗口剩多少只取决于本次输入。缺了这一项，就只剩两个选择：要么保守到 16384
 * （写作任务天天撞），要么无脑拉满（输入快撑满时整轮被拒）。
 *
 * 口径抄 opencode（`model-request.ts:88-99`）：输入按 `1 + 15%` 计（它们按 ~4 字符/token
 * 估，代码这类密文会低估，所以留垫），并设下限 1024（压到 0 等于不让它说话）。
 *
 * @param contextLimit 模型窗口（models.dev `limit.context`）；未知 = null（不施加窗口限制）
 * @param inputTokens 本次输入已占的 token（上一步 provider 报的值；首次请求 = null 当 0）
 * @returns 可用的输出 token 上限；窗口未知时 null（调用方只用软上限与模型上限）
 */
export const OUTPUT_WINDOW_FLOOR = 1024;
/** 输入侧按比例留的余量（低估修正），与 opencode 的 `ESTIMATE_ERROR = 0.15` 同一口径 */
export const OUTPUT_INPUT_HEADROOM = 0.15;

export function outputRoomInWindow(
    contextLimit: number | null | undefined,
    inputTokens: number | null | undefined,
): number | null {
    const ctx = posInt(contextLimit);
    if (ctx === null) return null;
    const used = posInt(inputTokens) ?? 0;
    const room = ctx - Math.ceil(used * (1 + OUTPUT_INPUT_HEADROOM));
    return Math.max(OUTPUT_WINDOW_FLOOR, room);
}

/**
 * 软上限是谁定的 —— **必须记下来**（##429 要求 ②：日志可查"这个数是谁拍的"）。
 *
 * 光有一个数字无法回答「为什么这次是 2000」：可能是人物配的、也可能是场景缺省。
 * 让解析结果自带来源层，事后翻 `raw` 日志 / 流量页就能对上账。
 */
export const OUTPUT_BUDGET_LAYERS = ["task", "persona", "global", "scene-default"] as const;
export type OutputBudgetLayer = (typeof OUTPUT_BUDGET_LAYERS)[number];

export interface OutputBudgetInput {
    scene: OutputScene;
    /** 任务级覆盖（任务 frontmatter 的 `max_output_tokens`）；未设 = null */
    task?: number | null;
    /** 人物级覆盖（personas.yaml 该人物的 `maxOutputTokens`）；未设 = null */
    persona?: number | null;
    /**
     * 全局覆盖（`DIY_LOCAL_MAX_OUTPUT_TOKENS` / `limits.json`）；**未配置 = null**。
     *
     * 为什么要区分 null 与数字：它同时是"缺省"与"用户显式设置"的边界。
     * 若把未配置也写成 16384，那"这层定的是场景缺省还是全局"就再也分不出来了。
     */
    global?: number | null;
    /** 模型硬上限（models.dev `limit.output`）；未知 = null（此时只用软上限，不设硬闸） */
    modelLimit?: number | null;
}

export interface OutputBudget {
    /** **真发下去的 `max_tokens`** = min(软上限, 模型硬上限) */
    tokens: number;
    /** 软上限（我们愿意付多少） */
    soft: number;
    /** 软上限由哪一层定（若被全局天花板压低，这里报 `global` —— 记的是**生效**的那一层） */
    layer: OutputBudgetLayer;
    /** 模型硬上限；未知 = null */
    modelLimit: number | null;
    /** 软上限被模型硬上限压低了吗（= 模型比我们更"穷"） */
    cappedByModel: boolean;
    /** 原始选择的层与值（被全局天花板压低前的样子）；压低了才有值，否则缺席 */
    clamped?: { layer: OutputBudgetLayer; value: number };
}

/** 有限正数 → 整数；否则 null（0 / 负数 / NaN / 非数字一律视为"没设"） */
function posInt(v: number | null | undefined): number | null {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
    return Math.floor(v);
}

/**
 * 解析一次请求的输出预算（**唯一判据**，真发 / 预览 / 回显都走这里）。
 *
 * 链条（##429 要求 ②）：任务 > 人物 > 全局（env / limits.json）> 场景缺省。
 * 然后（要求 ①）：`tokens = min(soft, 模型硬上限)`。
 *
 * ⚠️ **全局层不只是"最后一个覆盖"，它还是天花板**：它表达的是「我这一台机器/这个人
 * 最多愿意付这么多」。所以即使任务/人物写了个更大的数，也不许越过它 ——
 * 否则"我把 env 调到 2000 省钱"会被某个人物配置悄悄作废，而这恰恰是最要命的场景
 * （钱）。被压低时 `clamped` 记下原值与来源，别让覆盖链变成黑箱。
 */
export function resolveOutputBudget(input: OutputBudgetInput): OutputBudget {
    const scene = input.scene;
    const task = posInt(input.task);
    const persona = posInt(input.persona);
    const global = posInt(input.global);
    const modelLimit = posInt(input.modelLimit);

    let layer: OutputBudgetLayer;
    let value: number;
    if (task !== null) {
        layer = "task";
        value = task;
    } else if (persona !== null) {
        layer = "persona";
        value = persona;
    } else if (global !== null) {
        layer = "global";
        value = global;
    } else {
        layer = "scene-default";
        value = OUTPUT_SCENE_DEFAULTS[scene];
    }

    let soft = value;
    let clamped: OutputBudget["clamped"];
    if (global !== null && global < value) {
        soft = global;
        clamped = { layer, value };
        layer = "global"; // 生效的是全局天花板
    }

    const tokens = modelLimit !== null && modelLimit < soft ? modelLimit : soft;
    return {
        tokens,
        soft,
        layer,
        modelLimit,
        cappedByModel: modelLimit !== null && modelLimit < soft,
        ...(clamped ? { clamped } : {}),
    };
}

/**
 * 一句话说明这次预算是怎么来的（日志 / 流量页 / notice 文案共用）。
 *
 * 例：`16384（人物设定）· 模型硬上限 131072`
 */
export function describeOutputBudget(b: OutputBudget): string {
    const why =
        b.layer === "task"
            ? "任务设定"
            : b.layer === "persona"
              ? "人物设定"
              : b.layer === "global"
                ? b.clamped
                    ? `全局天花板（压低自${b.clamped.layer === "task" ? "任务" : "人物"}的 ${b.clamped.value}）`
                    : "全局设定"
                : "场景缺省";
    const head = `${b.tokens}（${why}）`;
    return b.modelLimit === null ? head : `${head} · 模型硬上限 ${b.modelLimit}${b.cappedByModel ? "（已压低）" : ""}`;
}
