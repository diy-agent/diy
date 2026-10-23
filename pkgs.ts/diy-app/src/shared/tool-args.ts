/**
 * **工具「生效参数」判据**（##408 用户 2026-10-23）：
 *
 * 用户原话：「工具定义里有 `background` / `timeout`，可聊天里看不见，我判断不了它是前台还是后台」
 * →「他们没有按工具定义发送参数……他们是**完整的参数请求**」。
 *
 * 病根：模型**只发它想改的**（`{command}`），缺省值是**代码里填的**（`?? 300000`、`!!background`）。
 * 于是「模型发的原文」与「工具实际收到的实参」是两份东西，只显示前者就会让人以为
 * 「background 没传 = 没这个参数」。
 *
 * 所以这里只做一件事：**把缺省值补上去**，并且**记住哪几个是补的**（`defaulted`）——
 * 不补就是猜，补了不标就是撒谎。
 *
 * 为什么单独成文件而不是写在 execute 里：同一份判据有两个消费者（工具真的按它执行、
 * 聊天里按它显示），写两遍必然漂；漂了以后"界面说前台、实际跑了后台"是最坏的那种错。
 * 纯函数、零 IO、零依赖（`limits` 由调用方传进来）。
 */

/** 一条工具调用的「生效参数」：补完缺省之后的实参 + 哪几个键是补上的 */
export interface EffectiveArgs {
    /** 补完缺省值的实参（`command` 原样搬过来） */
    args: Record<string, unknown>;
    /** 模型**没发**、由代码补上缺省值的键名（按参数定义顺序） */
    defaulted: string[];
}

/** `bash` 工具缺省超时的兜底（`limits` 缺字段时用；与 `DEFAULT_LIMITS.bashTimeoutMs` 同值） */
export const DEFAULT_BASH_TIMEOUT_MS = 300_000;

function num(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * `bash` 的生效参数。
 *
 * 口径与 `runBash` **完全一致**（那是执行侧的真源，这里的单测钉住两边同形）：
 * - `timeout` 省略 ⇒ `limits.bashTimeoutMs`
 * - `timeout === 0` ⇒ 0 = **不设超时**（不是"立刻超时"）
 * - 负数 / 小数 ⇒ 夹到 0 / 向下取整（`Math.max(0, Math.floor(x))`）
 * - 非数字（模型偶尔给字符串）⇒ 当没给，回缺省
 * - `background` 省略/假值 ⇒ false
 */
export function effectiveBashArgs(raw: unknown, limits: { bashTimeoutMs?: number }): EffectiveArgs {
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const defaulted: string[] = [];

    const rawTimeout = num(src.timeout);
    const fallback = num(limits.bashTimeoutMs) ?? DEFAULT_BASH_TIMEOUT_MS;
    let timeout: number;
    if (rawTimeout === undefined) {
        timeout = fallback;
        defaulted.push("timeout");
    } else {
        timeout = Math.max(0, Math.floor(rawTimeout));
    }

    const background = src.background === true || (src.background !== undefined && Boolean(src.background));
    if (src.background === undefined) defaulted.push("background");

    return {
        args: {
            command: typeof src.command === "string" ? src.command : "",
            timeout,
            background,
        },
        defaulted,
    };
}
