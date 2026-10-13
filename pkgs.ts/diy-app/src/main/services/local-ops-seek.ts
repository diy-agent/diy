// src/main/services/local-ops-seek.ts
// 🎯 大会话冷加载的「seek 起点」—— 只算窗口从哪个字节开始，不解析全文件、不 fold
//
// 【背景】##290 的折叠（compactOps）把 74MB / 877,050 op 压到 ~15MB / 1.8 万 op，
// 但**冷加载仍是整份**：读盘 + 全量 fold（~2.3s，主线程阻塞）+ 15.2MB 回包。
// 分页只 fold「最近一段」，滚动上取时再往前补一段。本模块只回答第一步：**窗口起点在哪**
// （接 `history({budgetBytes})` 与渲染端滚动上取是后续，见任务 ##293）。
//
// 【语义】`seekWindowStart(fp, budgetBytes)` = **≤ `totalBytes - budgetBytes` 的最近一个轮首**（floor）。
// 向上取（floor）而非向下（ceil）的两个理由：
//   · 向下时窗口可能**不足**预算 —— 尾部单轮自己就超预算时，`size - budget` 到文件尾一个轮首都
//     找不到，必须回头向上找 → 多一条兜底分支；
//   · 向上只会超额（最多多一轮），**永不落空** → 无兜底分支。
//
// 【硬约束】切点必须落在**轮 `start` 行的行首**：依赖完整轮的算量（用量 / 轮次统计等）才成立。
// 切在轮内会让部分块塌成根节点、跨切点的 patch 丢失（实测 42~154 条 issue/窗口）。
// 窗口内除末轮（可能正在流式写）外每轮都完整。
//
// 【三条保证】（单测钉住）
//   ① 返回偏移恒在**行首**（字节偏移；UTF-8 多字节内容不按字符数算）；
//   ② 返回 `0` 或 `size - offset >= budgetBytes`（`0` = 全量，语义上永远合法）；
//   ③ 窗口内每轮完整（折叠零 issue、块不塌成根）。
//
// 【成本】与文件总大小**无关**：从 `size - budget` 向前逐块回溯，取到最近轮首即停
// （实测 74.8MB / 48 轮会话 7~11ms；对照全量 fold 2.3s）。
//
// 【失败即降级（安全方向）】识别不出轮首一律返回 0 = 退化成全量，**永远给不出错的窗口**：
// 轮首行的字面模式（`TURN_PREFIX`，依赖写出端的 JSON 键序）将来若变了，最坏结果是分页失效，
// 不是窗口错位。
//
// 【边界】（实测，详见任务 ##293）
//   · 单个块自身不可切：一天的任务若就是一个 tool/think 块持续追加（现由 maxSteps 200 /
//     outputClipChars 6000 兜着，实测单块 ≤1.1MB、单轮 ≤8.7MB），放开限制后窗口会退化
//     → 终局方案（固定 step 数 + 补桩）或 appender 侧分段闭合。
//   · 轮首也非 100% 干净：t184 有 8 条跨轮 `stop 未知块`（无害，由「忽略并记 issue」的既有策略覆盖）。
import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * 轮首行的字面前缀（`JSON.stringify({op,id,kind,...})` ⇒ 键序 op → id → …）。
 * 只用于**快速定位候选**：是否真是轮首一律用 JSON.parse 复核（内容里凑巧出现同样字节串不算）。
 */
const TURN_PREFIX = '{"op":"start","id":"';

/** 回溯块大小：一块足以装下成百上千行；匹配跨块也无妨（下一块接着往前找）。 */
export const SEEK_CHUNK_BYTES = 256 * 1024;

/** 单行读取上限 —— 轮首行只带 meta（model/reasoningEffort），几百字节；超了就不可能是轮首行。 */
const MAX_LINE_BYTES = 64 * 1024;

const NEEDLE = Buffer.from(TURN_PREFIX, "utf-8");

/** 读 `[from, to)` 的全部字节。**必须循环读满**：短读（信号打断）会把 `allocUnsafe` 的未初始化区
 *  当数据（与 local-agent 的 readOpsRange 同策略，那里踩过"永久跳掉一段对话"的坑）。 */
function readRange(fd: number, from: number, to: number): Buffer {
    const len = Math.max(0, to - from);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
        const n = readSync(fd, buf, got, len - got, from + got);
        if (n <= 0) break;
        got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
}

/** 读 `at` 起到行尾的内容（不含换行）；超长行按上限截断（截断后 JSON 解析必然失败 → 跳过，安全）。 */
function readLineAt(fd: number, at: number): string {
    const buf = Buffer.allocUnsafe(MAX_LINE_BYTES);
    const got = readSync(fd, buf, 0, MAX_LINE_BYTES, at);
    if (got <= 0) return "";
    const nl = buf.subarray(0, got).indexOf(0x0a);
    return buf.subarray(0, nl < 0 ? got : nl).toString("utf-8");
}

/** 单字节（越界返回 -1）—— 仅用于块边界处判断"命中点是不是行首"。 */
function byteAt(fd: number, at: number): number {
    const b = Buffer.allocUnsafe(1);
    return readSync(fd, b, 0, 1, at) === 1 ? b[0]! : -1;
}

/** 命中点是否落在行首（前一个字节是换行，或就在文件头）。 */
function isLineStart(fd: number, buf: Buffer, from: number, hit: number): boolean {
    if (hit > 0) return buf[hit - 1] === 0x0a;
    if (from === 0) return true;
    return byteAt(fd, from - 1) === 0x0a;
}

/** 候选处是否真是轮 `start` 行（行首 + JSON 可解析 + op/kind 对得上）。 */
function isTurnStartLine(fd: number, at: number): boolean {
    const line = readLineAt(fd, at);
    if (!line) return false;
    try {
        const op = JSON.parse(line) as { op?: unknown; kind?: unknown };
        return op.op === "start" && op.kind === "turn";
    } catch {
        return false; // 半行 / 被截断 / 内容行
    }
}

/**
 * 取「窗口起点」的字节偏移：**≤ `size - budgetBytes` 的最近一个轮首**（floor）。
 *
 * 返回 `0` 即「从文件头开始」= 全量（预算 ≥ 全文件，或前面根本没有更近的轮首）。
 * 纯读、无副作用；文件夹不存在返回 0。
 */
export function seekWindowStart(fp: string, budgetBytes: number): number {
    let size: number;
    try {
        size = statSync(fp).size;
    } catch {
        return 0; // 尚无日志 = 无窗口
    }
    if (size <= 0) return 0;
    // 预算无效（NaN / 负数）按 0 处理：退化成「只取最后一个轮首」，不会给出越界偏移。
    // `+Infinity` 例外 —— 它走自然算术（`size - ∞ = -∞` ⇒ 全量），语义就是"不留可省之处"。
    const budget = Number.isNaN(budgetBytes) ? 0 : Math.max(0, budgetBytes);
    const target = size - budget; // 「窗口 ≥ budget」⟺「起点 ≤ target」
    if (target <= 0) return 0; // 预算 ≥ 全文件：没有任何可省的
    const fd = openSync(fp, "r");
    try {
        // 右界取 `target + needle` 而非 `target`：候选**允许恰好在 target**（此时窗口 = 预算），
        // 而判定一条模式要读到它的完整字节（开区间会漏掉正好压在 target 上的轮首）。
        let hi = Math.min(size, target + NEEDLE.length); // 当前回溯块的右界（不含）
        for (;;) {
            const from = Math.max(0, hi - SEEK_CHUNK_BYTES);
            const buf = readRange(fd, from, hi);
            // 从右往左找候选（预算贴近尾部时第一个命中就是答案）
            let pos = buf.length;
            while (pos > 0) {
                const hit = buf.lastIndexOf(NEEDLE, Math.min(pos - 1, buf.length - 1));
                if (hit < 0) break;
                const at = from + hit;
                if (at <= target && isLineStart(fd, buf, from, hit) && isTurnStartLine(fd, at))
                    return at;
                pos = hit; // 继续往左找
            }
            if (from === 0) return 0; // 找到文件头都没有轮首 → 全量（安全降级）
            hi = from;
        }
    } finally {
        closeSync(fd);
    }
}
