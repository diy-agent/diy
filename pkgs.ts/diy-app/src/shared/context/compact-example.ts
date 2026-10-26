// src/shared/context/compact-example.ts
// 🎯 「压缩后长什么样」的**范例预览**（##423 块 3）：一份**合成**的消息序列（每条带字节/token 尺寸），
//    按「上限 + 从后往前数 + 保头」算出哪些留下、哪些丢掉，给界面左右对照。
//
// ── 为什么是合成数据而不是真会话 ──
// 用户要的是「配置改了会怎样」的**可读演示**（2026-10-25：「生成一个范例消息，标注其模拟的 token size，
// 然后达到压缩后，右边呈现出压缩的新消息 history 形态」）。真会话不可复现（大小随任务变），
// 一份固定样例才能让人一眼看懂「上限调小 = 从哪里开始砍」。
//
// ── 边界判据不在这里 ──
// 留谁丢谁**一律**走 `./select-kept-boundary.ts::selectKeptBoundary`（唯一实现点，##432 的临时代管）。
// 本文件只做两件事：① 提供合成样例（`EXAMPLE_MESSAGES`）；② 把边界结果翻译成界面字段
// （`kept` / `why` / `dropped` / `keptBytes` / `biggestDrop`）。
// 🚫 不许在本文件再写一份累加 / 配平逻辑 —— 示例与真实行为不一致比没有示例更糟。
//
// 纯函数：禁止 import node:*。

import { RETAIN_RATIO, selectKeptBoundary, type KeptBoundary } from "./select-kept-boundary";

export { RETAIN_RATIO } from "./select-kept-boundary";

/** 合成样例里的一条消息（`bytes` 按 UTF-8 字节；token 见 `bytesToTokens` 的口径说明） */
export interface ExampleMessage {
    id: string;
    /** 哪一轮（`t1`…；与界面上的轮次对齐，纯展示） */
    turn: string;
    role: "user" | "assistant" | "tool";
    /** `user` 任务/插话 · `text` 助手正文 · `call` 工具调用 · `result` 工具结果 */
    kind: "user" | "text" | "call" | "result";
    /** 人读一句话（样例里写的是能被认出来的假内容，不是 lorem） */
    label: string;
    bytes: number;
    /** 工具调用与结果配对用（`call`/`result` 成对，同 id） */
    callId?: string;
}

/**
 * 样例的字节 → token：**3 字节 ≈ 1 token**。
 *
 * 为什么不是 ÷4：本文件每条 `label` 都是**中文**正文，而压缩的真实口径是
 * `history-limit.ts::estimateTokensOf`（CJK 码点 1 token/字、其余 /4）。中文 UTF-8 是 3 字节/字
 * ⇒ 一条「N 字节中文」的 token 数 ≈ `N / 3`。用 ÷4 会把样例低估 25%：
 * 预览说「上限 4000 能留 8 条」、真压只留 6 条 —— 本文件头注那句「示例与真实行为不一致比没有示例更糟」
 * 正是防这个。`tests/core/compact-example.test.ts` 有一条用例把这里的口径与 `estimateTokensOf` 对齐钉住。
 */
export const bytesToTokens = (bytes: number): number => Math.round(bytes / 3);

/**
 * 合成样例：6 轮、含 4 组工具调用/结果，合计约 30 KB（≈10k token，按 3 字节 ≈ 1 token 的中文口径）。
 * 尺寸**故意不均匀**（工具结果远大于正文）—— 这正是压缩的主要作用对象，均匀样例看不出取舍。
 */
export const EXAMPLE_MESSAGES: readonly ExampleMessage[] = [
    { id: "m1", turn: "t1", role: "user", kind: "user", label: "「把 login 的 401 修掉，别动鉴权中间件」", bytes: 1600 },
    { id: "m2", turn: "t1", role: "assistant", kind: "text", label: "先定位：401 来自 token 过期判断…", bytes: 3200 },
    { id: "m3", turn: "t1", role: "assistant", kind: "call", label: "rg -n '401' src/auth", bytes: 800, callId: "c1" },
    { id: "m4", turn: "t1", role: "tool", kind: "result", label: "37 处命中（含 3 个测试文件）", bytes: 12000, callId: "c1" },
    { id: "m5", turn: "t2", role: "user", kind: "user", label: "「顺便看看刷新逻辑」", bytes: 600 },
    { id: "m6", turn: "t2", role: "assistant", kind: "text", label: "refreshToken 的时钟漂移会导致误判…", bytes: 4000 },
    { id: "m7", turn: "t2", role: "assistant", kind: "call", label: "sed -n '1,120p' src/auth/refresh.ts", bytes: 700, callId: "c2" },
    { id: "m8", turn: "t2", role: "tool", kind: "result", label: "120 行源码（含注释）", bytes: 16000, callId: "c2" },
    { id: "m9", turn: "t3", role: "user", kind: "user", label: "「写个测试覆盖时钟漂移」", bytes: 500 },
    { id: "m10", turn: "t3", role: "assistant", kind: "text", label: "测试要覆盖：now > exp 与 now < exp 两侧…", bytes: 3600 },
    { id: "m11", turn: "t3", role: "assistant", kind: "call", label: "npm test -- refresh", bytes: 600, callId: "c3" },
    { id: "m12", turn: "t3", role: "tool", kind: "result", label: "42 passed / 0 failed（含日志）", bytes: 14000, callId: "c3" },
    { id: "m13", turn: "t4", role: "user", kind: "user", label: "「把失败原因写进注释」", bytes: 700 },
    { id: "m14", turn: "t4", role: "assistant", kind: "text", label: "三处注释改写（判据 + 反例）…", bytes: 5200 },
    { id: "m15", turn: "t4", role: "assistant", kind: "call", label: "git diff --stat", bytes: 600, callId: "c4" },
    { id: "m16", turn: "t4", role: "tool", kind: "result", label: "5 files changed, 82 insertions(+)", bytes: 9000, callId: "c4" },
    { id: "m17", turn: "t5", role: "user", kind: "user", label: "「跑一遍 check」", bytes: 400 },
    { id: "m18", turn: "t5", role: "assistant", kind: "text", label: "check 通过（0 error）…", bytes: 2600 },
    { id: "m19", turn: "t6", role: "user", kind: "user", label: "「开 PR」", bytes: 900 },
    { id: "m20", turn: "t6", role: "assistant", kind: "text", label: "PR #999 已开（GPG 已签，未 merge）…", bytes: 1800 },
];

export interface ExampleRow extends ExampleMessage {
    kept: boolean;
    /** 为什么留 / 为什么丢（界面 hover 用，别让人猜） */
    why: string;
    /** 估算 token（= `bytesToTokens(bytes)`，3 字节 ≈ 1 token：样例正文是中文） */
    tokens: number;
}

export interface CompactExampleResult {
    rows: ExampleRow[];
    /** 从后往前数出来的切点下标（0 = 什么都丢不掉；##442 起无保头） */
    cut: number;
    keptBytes: number;
    beforeBytes: number;
    /** 丢掉的**条数** */
    dropped: number;
    /** 丢掉的最大一块（工具结果 / 正文），界面上说「主要砍的是谁」 */
    biggestDrop: ExampleRow | null;
}

/**
 * 算出「按这个上限压完长什么样」。留谁丢谁 = `selectKeptBoundary` 说了算，这里只排版。
 *
 * @param budgetTokens 上限（**token**，与真实压缩同一个口径 —— ##432 的唯一旋钮）
 * @param messages 默认用 `EXAMPLE_MESSAGES`（测试可传小样例）
 */
export function buildCompactExample(
    budgetTokens: number,
    messages: readonly ExampleMessage[] = EXAMPLE_MESSAGES,
): CompactExampleResult {
    const beforeBytes = messages.reduce((a, m) => a + m.bytes, 0);
    // ##442：参数就是「保留量」（窗口 × retainRatio），触发线按同一窗口推（触发比例 0.8 = 缺省）
    const { cut }: KeptBoundary = selectKeptBoundary(
        messages.map((m) => ({ tokens: bytesToTokens(m.bytes), user: m.kind === "user" })),
        budgetTokens,
        Math.max(budgetTokens + 1, Math.round(budgetTokens / RETAIN_RATIO * 0.8)),
    );

    const rows: ExampleRow[] = messages.map((m, i) => {
        if (i >= cut) return rowOf(m, true, "在本次请求里（从最后往前数，装够保留量；切点落在 user 上）");
        return rowOf(m, false, "超出保留量 ⇒ 不进本次请求（摘要 / 自取指令顶替它）");
    });

    const keptRows = rows.filter((r) => r.kept);
    const droppedRows = rows.filter((r) => !r.kept);
    const biggest = droppedRows.reduce<ExampleRow | null>((a, r) => (a && a.bytes >= r.bytes ? a : r), null);
    return {
        rows,
        cut,
        keptBytes: keptRows.reduce((a, r) => a + r.bytes, 0),
        beforeBytes,
        dropped: droppedRows.length,
        biggestDrop: biggest,
    };
}

function rowOf(m: ExampleMessage, kept: boolean, why: string): ExampleRow {
    return { ...m, kept, why, tokens: bytesToTokens(m.bytes) };
}
