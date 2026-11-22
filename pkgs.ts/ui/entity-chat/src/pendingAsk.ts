/**
 * 侧栏 `?`（还有几个提问在等我答）的合并规则。
 *
 * 两个来源，优先级不是「谁更新」，而是按**这份数字还准不准**排：
 *
 * 1. 正在看的房间：会话流说了算。流是常驻 SSE，答完那一刻 gate 就结算了；`/rooms` 投影
 *    最短也要等下一轮轮询（30 秒），用它会把「刚答完的提问」又点亮一阵。
 * 2. 其余一律以服务端投影为准 —— **包括看过的房间**。切走时那条订阅会被摘掉
 *    （`conversationOf().dispose()` → `release`），本地这份从此不再更新；再继续本地优先的话，
 *    提问在别处有了结局之后 `?` 会一直亮着，服务端的 0 永远盖不回去。
 *
 * 交给流的前提是「流已经来过一份快照」（调用方传 `liveRoomId` 时才成立）：刚
 * `conversationOf()` 时 asks 还是空的（快照在路上），拿这份空数组盖服务端会让 `?` 先灭再亮。
 */
export function mergePendingAsks(
    server: Record<string, number>,
    local: Record<string, number>,
    /** 流在手、且已热身的房间 id；`''` = 没有这样的房间 */
    liveRoomId: string,
): Record<string, number> {
    const merged: Record<string, number> = {};
    for (const [id, count] of Object.entries(server)) {
        if (count > 0) merged[id] = count;
    }
    if (liveRoomId === '') return merged;
    const count = local[liveRoomId] ?? 0;
    if (count > 0) merged[liveRoomId] = count;
    else delete merged[liveRoomId];
    return merged;
}

/**
 * `/rooms` 投影里那句 tooltip：`?` 只说几个，这里还要说**问的是什么**
 * （用户报的「进房间不知道是哪个提问」就是这一步缺的）。
 *
 * 抽成纯函数是为了测得动：题干来自服务端投影 / 会话流两处，文案却必须一致。
 */
export function pendingAskHintOf(count: number, titles: readonly string[], limit = 28): string {
    const head = `${count} 个提问等你回答`;
    if (titles.length === 0) return head;
    const shown = titles.map((title) => `「${truncateTitle(title, limit)}」`).join('');
    return `${head}：${shown}`;
}

/** tooltip 里一句题干最多这么长：再长就截断（完整题干在房间里的卡片上） */
export function truncateTitle(title: string, limit = 28): string {
    const text = title.trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 待答条上的一枚 chip：一题就报题干，多题报首句 + `+N`（整批的题目放在 title 里）。
 */
export function askChipOf(questions: readonly { question: string }[], limit = 24): string {
    const first = questions[0];
    const head = truncateTitle(first?.question ?? '提问', limit);
    const rest = questions.length - 1;
    return rest > 0 ? `${head} +${rest}` : head;
}

/** 待答条 chip 的 tooltip：整批题目一行一条 */
export function askChipTitleOf(questions: readonly { question: string }[]): string {
    return [`还有 ${questions.length} 题等你回答`, ...questions.map((question) => `· ${question.question}`)].join('\n');
}
