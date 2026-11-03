/**
 * chat-text —— 大文本的**窗口化**取行 / 计数（##93）
 *
 * 病根：`firstLine` / `previewLines` / `clampLines` 原来都对**整块全文** `split("\n")`，
 * 且都不是 memo —— 它们被 `summaryOf()` / `pv()` / 折叠判据在 JSX（效应用）里**每帧**调用。
 * 实测（3.28 M 字符单块）：`split` 11.62 ms 一次，可见 20 块时每帧 7.2 / 18.8 ms，
 * 而 60 fps 的预算是 16 ms ⇒ 一个 3 MB 思考块就把预算吃光。
 *
 * 处置：**只看需要的那一小段**。摘要只要开头第一行 / 前后各几十行，窗口化后
 * 3.28 M 单块从 0.36 / 0.94 ms 降到 **0.0018 / 0.03 ms**（≈200×）。
 *
 * 两条硬规矩（本模块的存在理由，改之前先读）：
 *   1. **不用 `split` 数行数**：`split("\n").length` 一次分配 4 万个字符串（3.28 M 实测 11.62 ms）；
 *      `countLines` 用 `indexOf` 循环零分配（2.31 ms，且只在「内容变了第一次」付一次，见调用方 memo）。
 *   2. **不静默返回错误数字**：窗口数不出精确总行数时（流式中的大块），`total` / `omitted`
 *      一律是**下界**并用 `exact=false` 说清楚，UI 措辞必须体现「≥」。
 *
 * `+=` 累加出来的 cons string 不是本模块要解决的问题：追加是 O(1) 摊销，**不要**为它改成
 * chunk 数组（收益 ≈ 0）；真贵的是每帧 flatten / split 的次数，也就是这里。
 */

/** 头部窗口（字符）：三个函数「看开头」时只用这一截 */
export const HEAD_WINDOW = 4096;
/** 尾部窗口（字符）：`previewLines` 的「后 30 行」/ `lastLine` 的「最后一行」取这一截 */
export const TAIL_WINDOW = 8192;

/** 行数（与 `split("\n").length` **同口径**：空串 = 1 行）；零分配 */
export function countLines(s: string): number {
    let n = 1;
    for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
    return n;
}

/** 窗口能给出的**行数下界**：头尾两窗口互不重叠 ⇒ 全文换行数 ≥ 两窗口之和 */
function lineCountLowerBound(text: string): number {
    const headEnd = Math.min(text.length, HEAD_WINDOW);
    const tailStart = Math.max(headEnd, text.length - TAIL_WINDOW);
    const head = text.slice(0, headEnd);
    const tail = tailStart > 0 ? text.slice(tailStart) : "";
    const inWindow = (s: string) => {
        let n = 0;
        for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
        return n;
    };
    return 1 + inWindow(head) + (tail ? inWindow(tail) : 0);
}

/**
 * 单行摘要：**第一行非空内容**（前导空行不算）。
 *
 * 为什么不是 `split("\n")[0]`：真实数据里思考正文常以换行开头（模型的 reasoning 前导 `\n`），
 * 取第一行会得空串 → 标题退回"思考"两个字，整页看不出这段在琢磨什么
 * （用户 2026-10-12 反馈："v4 的思考 bar 会显示思考的第一行"）。空行跳过，再截 90 字。
 *
 * 窗口化（##93）：**只按行推进，每行只看前 `HEAD_WINDOW` 个字符**——摘要只要前 90 字，
 * 一行 3 MB 也不必整行切片。语义与「整篇 split 后取第一行」逐字一致
 * （判据见 `tests/core/chat-text.test.ts`）。
 */
export function firstLine(s: string, max = 90): string {
    const len = s.length;
    let pos = 0;
    while (pos < len) {
        let to = Math.min(len, pos + HEAD_WINDOW);
        let lineEnd = -1; // 行尾（那个换行的位置）；-1 = 这一行还没走完
        let t = "";
        for (;;) {
            const chunk = s.slice(pos, to);
            const nl = chunk.indexOf("\n");
            t = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
            if (nl !== -1) {
                lineEnd = pos + nl;
                break;
            }
            if (t.length >= max || to >= len) break; // 够字了（再多也截掉）/ 到串尾了
            to = Math.min(len, to + HEAD_WINDOW); // 前段全是空白：往后看
        }
        if (t) return t.slice(0, max);
        if (lineEnd === -1) return ""; // 到最后一行都是空的
        pos = lineEnd + 1;
    }
    return "";
}

/**
 * 取文本的**最后一行非空**（意图末行用；与 `firstLine` 对称）。
 *
 * 窗口化同 `firstLine`：从尾部按行回退，`lastIndexOf` 每退一行只扫那一行；
 * 超长行也只在「判截断要 max 字」时才多看一段 —— 不整篇 split。
 */
export function lastLine(text: string, max = 90): string {
    let end = text.length;
    while (end > 0) {
        const nl = text.lastIndexOf("\n", end - 1);
        const start = nl + 1; // nl === -1 ⇒ start = 0（这一段从串首开始）
        const t = lineHead(text, start, end, max).trim();
        if (t) return t.length > max ? `${t.slice(0, max)}…` : t;
        if (start === 0) return "";
        end = start - 1; // 这一行是空的：跳过它继续往前
    }
    return "";
}

/** `[start, end)` 这一行的前段（最多 `max` 个字非空白）；超长行不整行切片 */
function lineHead(text: string, start: number, end: number, max: number): string {
    let from = start;
    for (;;) {
        const to = Math.min(end, from + HEAD_WINDOW);
        const chunk = text.slice(from, to);
        const t = chunk.trimStart();
        // 非空白内容够 max 字，或已到行尾 ⇒ 够判
        if (t.length > max || to >= end) return text.slice(start, to);
        from = to;
    }
}

/** 输出截断：head + tail，中间计省略行数（行内展开用；超预算才挂全屏按钮） */
export interface Preview {
    text: string;
    /** 被省掉的行数（`exact === false` 时是**下界**） */
    omitted: number;
    /** 全文行数（`exact === false` 时是**下界**） */
    total: number;
    /** `total` / `omitted` 是精确值还是下界（下界时 UI 必须写「≥」） */
    exact: boolean;
}

/**
 * 前 n 行——**每行都完整**（`indexOf` 逐行推进，只扫到第 n 个换行为止）。
 * 全文不足 n 行 ⇒ `null`（调用方据此知道根本没被截断）。
 */
function takeFirstLines(text: string, n: number): string[] | null {
    let idx = -1;
    for (let k = 0; k < n; k++) {
        const nl = text.indexOf("\n", idx + 1);
        if (nl === -1) return null;
        idx = nl;
    }
    return text.slice(0, idx).split("\n");
}

/**
 * 后 n 行（同样每行完整）：从尾部数 n 个换行定位行首，只切需要的那一段。
 * 全文不足 n 行 ⇒ `null`。`lastIndexOf` 每次只扫到上一个换行，不会 O(n²)。
 */
function takeLastLines(text: string, n: number): string[] | null {
    let idx = text.length;
    for (let k = 0; k < n; k++) {
        const nl = text.lastIndexOf("\n", idx - 1);
        if (nl === -1) return null;
        idx = nl;
    }
    return text.slice(idx + 1).split("\n");
}

/**
 * 输出预览：前 `head` + 后 `tail` 行，中间标出省略行数。
 *
 * `total`（可选）= 调用方**按块版本 memo** 出来的精确行数（`countLines`）。给了就用精确值；
 * 不给时按窗口下界走，只有窗口**判不出来**（行太长 / 行太少）才真数一次：
 *   · 下界已超出预算 ⇒ 窗口就够证明被截断了 → 直接裁，`omitted` 写下界（不每帧数 3 MB）；
 *   · 判不出来 ⇒ `countLines`（零分配，3.28 M 实测 2.31 ms）数一次拿精确值。
 *     不猜「行少所以不截」—— 一行 3 MB 的 JSON 真去画整段是另一种灾难（见 ##93 的 D 条）。
 */
export function previewLines(text: string, head = 20, tail = 30, total?: number): Preview {
    const need = head + tail;
    // 短文本：整段都在两个窗口内 → 与原实现（一次 split 全文）逐字一致
    if (text.length <= HEAD_WINDOW + TAIL_WINDOW) {
        const lines = text.split("\n");
        if (lines.length <= need) return { text, omitted: 0, total: lines.length, exact: true };
        const omitted = lines.length - need;
        return {
            text: [...lines.slice(0, head), `… 省略 ${omitted} 行 …`, ...lines.slice(-tail)].join("\n"),
            omitted,
            total: lines.length,
            exact: true,
        };
    }
    let n: number;
    let exact: boolean;
    if (total !== undefined) {
        n = total;
        exact = true;
    } else {
        const lb = lineCountLowerBound(text);
        // 下界已够判「被截断」→ 不数全文；否则数一次（零分配）拿精确值
        [n, exact] = lb > need ? [lb, false] : [countLines(text), true];
    }
    if (n <= need) return { text, omitted: 0, total: n, exact };
    const headLines = takeFirstLines(text, head);
    const tailLines = takeLastLines(text, tail);
    if (headLines === null || tailLines === null) {
        // 兜底（超长行 / 数据形状极端）：退回全量 split —— 慢但语义保证一致。
        // 正常数据走不到这里：进到这里说明「总行数够、但某一行比窗口还长」。
        const lines = text.split("\n");
        if (lines.length <= need) return { text, omitted: 0, total: lines.length, exact: true };
        const omitted = lines.length - need;
        return {
            text: [...lines.slice(0, head), `… 省略 ${omitted} 行 …`, ...lines.slice(-tail)].join("\n"),
            omitted,
            total: lines.length,
            exact: true,
        };
    }
    const omitted = n - need;
    const marker = exact ? `… 省略 ${omitted} 行 …` : `… 至少省略 ${omitted} 行 …`;
    return { text: [...headLines, marker, ...tailLines].join("\n"), omitted, total: n, exact };
}

/** `clampLines` 的结果（`exact` 同 `Preview.exact`：`omitted` 是精确值还是下界） */
export interface Clamped {
    text: string;
    omitted: number;
    exact: boolean;
}

/**
 * 按可视行数截断正文（**1 级「摘要结论」**的摘要态；Markdown 不解析时也走这里）。
 *
 * 只截**行**不截字符：正文里代码块/列表被字符数切开比少几行更难看懂。
 * 返回 omitted（被藏起来的行数）而不是布尔 —— 界面要说出"还有几行"，
 * 光一个 `…` 信息量太低（2026-10-11 用户反馈：看不出被裁过）。
 *
 * 窗口化（##93）：只切头 `HEAD_WINDOW`；`total` 同 `previewLines`（给了用精确值，不给用下界）。
 */
export function clampLines(text: string, n: number, total?: number): Clamped {
    const len = text.length;
    let to = Math.min(len, HEAD_WINDOW);
    for (;;) {
        const parts = text.slice(0, to).split("\n");
        const atEnd = to >= len;
        // 前导空行不是正文（Markdown 里首个块之前的空行渲染时本来就被吃掉）
        let start = 0;
        while (start < parts.length && parts[start]!.trim() === "") start++;
        const cut = start + n; // 保留 n 行之后那一行的下标
        // 它确实在窗口里 ⇒ 前 n 行都完整、且后面还有内容（窗口末被切断的那一段也算「还有」）
        if (cut < parts.length) {
            // 已到串尾 ⇒ 窗口里的段数就是全文行数（精确）；否则只能是下界
            let exact = total !== undefined || atEnd;
            let count = total ?? (atEnd ? parts.length : 0);
            if (count === 0) {
                const lb = lineCountLowerBound(text);
                if (lb - start - n > 0)
                    count = lb; // 下界就够报出「藏了几行」
                else {
                    // 长行 / 行少 ⇒ 下界报不出数：数一次（零分配）拿精确值，别拿 0 冒充
                    count = countLines(text);
                    exact = true;
                }
            }
            // 计数与窗口证据矛盾（只可能来自调用方传了过期 total）：按「没截」处理，不藏内容
            const omitted = count - start - n;
            if (omitted <= 0) return { text, omitted: 0, exact };
            return { text: parts.slice(start, cut).join("\n"), omitted, exact };
        }
        if (atEnd) {
            // 到串尾：前导空行之外全是正文（原实现的 kept.join 的等价切片）
            const pos = start >= parts.length ? len : offsetOf(parts, start);
            // 窗口已到串尾 ⇒ 全文都在手里，"没截" 是确定的
            return { text: pos === 0 ? text : text.slice(pos), omitted: 0, exact: true };
        }
        to = Math.min(len, to * 2);
    }
}

/** 第 i 段在原文里的起点偏移（parts = `text.slice(0, to).split("\n")`） */
function offsetOf(parts: readonly string[], i: number): number {
    let off = 0;
    for (let k = 0; k < i; k++) off += parts[k]!.length + 1;
    return off;
}
